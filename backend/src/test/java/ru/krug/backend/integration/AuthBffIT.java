package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.auth.api.dto.AuthRegisterResponse;
import ru.krug.backend.auth.api.dto.AuthSessionResponse;
import ru.krug.backend.support.AuthCookieTestSupport;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.KeycloakWireMock;
import ru.krug.backend.support.MockMailSender;
import ru.krug.backend.support.OpenApiContract;
import ru.krug.backend.support.TestMailConfig;

/**
 * Auth BFF end-to-end: real MockMvc + PostgreSQL + WireMock Keycloak (admin/token/userinfo/
 * JWKS) + captured SMTP. Access tokens are real RS256 JWTs, so {@code GET /me} runs through
 * the production Keycloak decoder.
 */
@SpringBootTest(properties = {
        // Test isolation: this profile does not load application-test.yml, so its
        // noop scanner would otherwise mark files of sibling test contexts CLEAN.
        "krug.files.scan-enabled=false",
        "krug.files.gc-enabled=false",
        "krug.files.reconcile-enabled=false",
        "krug.content.key=auth-bff-test-content-key-please-change-32",
        "krug.auth-bff.code.secret-key=auth-bff-test-email-secret-key-please-change-32",
        "krug.auth-bff.cleanup.enabled=false",
        "krug.auth-bff.keycloak.admin-password=auth-bff-test-admin",
        // #103: the real end-to-end path uses the client-credentials service account; the
        // legacy password property is present below so the test can prove it is unused.
        "krug.auth-bff.keycloak.service-client-id=svc-krug-bff",
        "krug.auth-bff.keycloak.service-client-secret=svc-krug-bff-test-secret-please-change-32",
        "krug.auth-bff.rate-limit.register-per-email=100",
        "krug.auth-bff.rate-limit.register-per-ip=1000",
        "krug.auth-bff.rate-limit.login-per-email=100",
        "krug.auth-bff.rate-limit.login-per-ip=1000",
        "krug.auth-bff.rate-limit.resend-per-email=100",
        "krug.auth-bff.rate-limit.resend-per-ip=1000"
})
@ActiveProfiles("keycloak")
@Import(TestMailConfig.class)
@ExtendWith(OutputCaptureExtension.class)
class AuthBffIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();
    private static final String PASSWORD = "VeryStrongPass123!";
    private static final String ALLOWED_ORIGIN = "http://localhost:5173";

    @Autowired
    private MockMailSender mail;

    @DynamicPropertySource
    static void keycloak(DynamicPropertyRegistry registry) {
        registry.add("krug.auth-bff.keycloak.base-url", KeycloakWireMock::baseUrl);
        registry.add("krug.oidc.issuer", KeycloakWireMock::issuer);
        registry.add("krug.oidc.jwk-set-uri", KeycloakWireMock::jwksUri);
    }

    @BeforeEach
    void resetFakeIdp() {
        KeycloakWireMock.reset();
        mail.clear();
    }

    @Test
    void registerVerifyAndMeMatchTheContract() throws Exception {
        String email = uniqueEmail("register");
        MvcResult register = register(email, "Дмитрий");
        JsonNode registerJson = json(register);
        CONTRACT.assertValid("AuthRegisterResponse", registerJson);
        UUID verificationId = UUID.fromString(registerJson.get("verification_id").asText());
        assertThat(registerJson.get("expires_in").asLong()).isEqualTo(600);
        assertThat(registerJson.get("resend_after").asLong()).isEqualTo(60);

        String code = mail.lastFor(email).code();
        assertThat(code).matches("[0-9]{6}");
        assertThat(mail.lastFor(email).email()).isEqualTo(email);

        // The Keycloak user is disabled + unverified until the code is accepted.
        KeycloakWireMock.TestUser pending = KeycloakWireMock.user(email);
        assertThat(pending.enabled()).isFalse();
        assertThat(pending.emailVerified()).isFalse();

        MvcResult verify = verify(verificationId, code);
        JsonNode sessionJson = json(verify);
        CONTRACT.assertValid("AuthSession", sessionJson);
        AuthSessionResponse session = objectMapper.readValue(
                verify.getResponse().getContentAsString(), AuthSessionResponse.class);
        assertThat(session.user().email()).isEqualTo(email);
        assertThat(session.user().displayName()).isEqualTo("Дмитрий");
        assertThat(session.accessToken()).isNotBlank();
        assertThat(session.tokenType()).isEqualTo("Bearer");
        // #103: no refresh token in the body; it arrives as an HttpOnly cookie.
        assertThat(sessionJson.has("refresh_token")).isFalse();
        String setCookie = AuthCookieTestSupport.setCookie(verify);
        assertThat(setCookie)
                .startsWith("sova_refresh=")
                .contains("HttpOnly")
                .contains("SameSite=Lax")
                .contains("Path=/api/v1/auth")
                .contains("Max-Age=")
                .doesNotContain("Secure") // localhost/http dev profile
                .doesNotContain("Domain=");

        assertThat(KeycloakWireMock.user(email).enabled()).isTrue();
        assertThat(KeycloakWireMock.user(email).emailVerified()).isTrue();
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM auth.email_verifications
                 WHERE id = ? AND consumed_at IS NOT NULL
                """, Integer.class, verificationId)).isEqualTo(1);

        MvcResult me = mockMvc.perform(get("/api/v1/me")
                        .header("Authorization", "Bearer " + session.accessToken()))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode meJson = json(me);
        CONTRACT.assertValid("MeResponse", meJson);
        assertThat(meJson.at("/user/id").asText()).isEqualTo(session.user().id().toString());
        assertThat(meJson.at("/user/email").asText()).isEqualTo(email);
        assertThat(meJson.get("workspaces")).isEmpty();
    }

    @Test
    void wrongCodeIs422AndIncrementsAttempts() throws Exception {
        String email = uniqueEmail("wrong");
        UUID verificationId = registerId(email);
        String wrong = wrongCode(mail.lastFor(email).code());

        MvcResult result = verifyResult(verificationId, wrong);
        assertThat(result.getResponse().getStatus()).isEqualTo(422);
        JsonNode error = json(result);
        CONTRACT.assertValid("Error", error);
        assertThat(error.get("code").asText()).isEqualTo("CODE_INVALID");
        assertThat(migrator().queryForObject("""
                SELECT attempts FROM auth.email_verifications WHERE id = ?
                """, Integer.class, verificationId)).isEqualTo(1);
        assertThat(KeycloakWireMock.user(email).enabled()).isFalse();
    }

    @Test
    void fiveWrongAttemptsEndWith429AndCorrectCodeIsRejected() throws Exception {
        String email = uniqueEmail("attempts");
        UUID verificationId = registerId(email);
        String correct = mail.lastFor(email).code();
        String wrong = wrongCode(correct);

        for (int attempt = 1; attempt <= 4; attempt++) {
            MvcResult result = verifyResult(verificationId, wrong);
            assertThat(result.getResponse().getStatus()).isEqualTo(422);
            assertThat(json(result).get("code").asText()).isEqualTo("CODE_INVALID");
        }
        MvcResult limited = verifyResult(verificationId, wrong);
        assertThat(limited.getResponse().getStatus()).isEqualTo(429);
        CONTRACT.assertValid("Error", json(limited));
        assertThat(json(limited).get("code").asText()).isEqualTo("RATE_LIMITED");
        assertThat(limited.getResponse().getHeader("Retry-After")).isNotBlank();

        assertThat(migrator().queryForObject("""
                SELECT attempts FROM auth.email_verifications WHERE id = ?
                """, Integer.class, verificationId)).isEqualTo(5);
        assertThat(verifyResult(verificationId, correct).getResponse().getStatus())
                .isEqualTo(429);
    }

    @Test
    void expiredCodeIs410() throws Exception {
        String email = uniqueEmail("expired");
        UUID verificationId = registerId(email);
        migrator().update("""
                UPDATE auth.email_verifications
                   SET created_at = now() - interval '11 minutes',
                       expires_at = now() - interval '1 second'
                 WHERE id = ?
                """, verificationId);

        MvcResult result = verifyResult(verificationId, mail.lastFor(email).code());
        assertThat(result.getResponse().getStatus()).isEqualTo(410);
        CONTRACT.assertValid("Error", json(result));
        assertThat(json(result).get("code").asText()).isEqualTo("CODE_EXPIRED");
    }

    @Test
    void resendHonoursCooldownAndRotatesTheCode() throws Exception {
        String email = uniqueEmail("resend");
        UUID verificationId = registerId(email);
        String firstCode = mail.lastFor(email).code();

        MvcResult tooSoon = mockMvc.perform(post("/api/v1/auth/resend-email-code")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("verification_id", verificationId))))
                .andReturn();
        assertThat(tooSoon.getResponse().getStatus()).isEqualTo(429);
        assertThat(json(tooSoon).get("code").asText()).isEqualTo("RATE_LIMITED");

        migrator().update("""
                UPDATE auth.email_verifications
                   SET last_sent_at = now() - interval '2 minutes'
                 WHERE id = ?
                """, verificationId);

        MvcResult resent = mockMvc.perform(post("/api/v1/auth/resend-email-code")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("verification_id", verificationId))))
                .andExpect(status().isAccepted())
                .andReturn();
        JsonNode resentJson = json(resent);
        CONTRACT.assertValid("AuthResendEmailCodeResponse", resentJson);
        assertThat(resentJson.get("resend_after").asLong()).isEqualTo(60);
        assertThat(resentJson.get("expires_in").asLong()).isBetween(1L, 600L);

        String secondCode = mail.lastFor(email).code();
        assertThat(secondCode).isNotEqualTo(firstCode);
        assertThat(verifyResult(verificationId, firstCode).getResponse().getStatus())
                .isEqualTo(422);

        MvcResult verified = verifyResult(verificationId, secondCode);
        assertThat(verified.getResponse().getStatus()).isEqualTo(200);
        CONTRACT.assertValid("AuthSession", json(verified));
    }

    @Test
    void duplicateEmailIs409() throws Exception {
        String email = uniqueEmail("duplicate");
        registerAndVerify(email);

        MvcResult duplicate = registerResult(email, "Дмитрий");
        assertThat(duplicate.getResponse().getStatus()).isEqualTo(409);
        CONTRACT.assertValid("Error", json(duplicate));
        assertThat(json(duplicate).get("code").asText()).isEqualTo("EMAIL_TAKEN");
    }

    @Test
    void unverifiedLoginIs403AndWrongPasswordIs401() throws Exception {
        String email = uniqueEmail("login");
        UUID verificationId = registerId(email);

        MvcResult unverified = loginResult(email, PASSWORD);
        assertThat(unverified.getResponse().getStatus()).isEqualTo(403);
        JsonNode error = json(unverified);
        CONTRACT.assertValid("Error", error);
        assertThat(error.get("code").asText()).isEqualTo("EMAIL_NOT_VERIFIED");
        assertThat(error.at("/details/verification_id").asText())
                .isEqualTo(verificationId.toString());

        MvcResult verified = verifyResult(verificationId, mail.lastFor(email).code());
        assertThat(verified.getResponse().getStatus()).isEqualTo(200);

        MvcResult wrong = loginResult(email, "WrongPassword123!");
        assertThat(wrong.getResponse().getStatus()).isEqualTo(401);
        CONTRACT.assertValid("Error", json(wrong));
        assertThat(json(wrong).get("code").asText()).isEqualTo("INVALID_CREDENTIALS");

        MvcResult correct = loginResult(email, PASSWORD);
        assertThat(correct.getResponse().getStatus()).isEqualTo(200);
        CONTRACT.assertValid("AuthSession", json(correct));
        AuthSessionResponse loggedIn = objectMapper.readValue(
                correct.getResponse().getContentAsString(), AuthSessionResponse.class);
        assertThat(loggedIn.user().displayName()).isEqualTo("Дмитрий");
    }

    @Test
    void refreshRotatesTheCookieAndLogoutRevokesClearsAndIgnoresTheBody() throws Exception {
        String email = uniqueEmail("refresh");
        UUID verificationId = registerId(email);
        MvcResult verified = verify(verificationId, mail.lastFor(email).code());
        assertThat(verified.getResponse().getStatus()).isEqualTo(200);
        AuthSessionResponse session = objectMapper.readValue(
                verified.getResponse().getContentAsString(), AuthSessionResponse.class);
        String firstCookie = AuthCookieTestSupport.value(verified);
        assertThat(firstCookie).isNotBlank();

        MvcResult refreshed = mockMvc.perform(AuthCookieTestSupport.withCookie(
                                post("/api/v1/auth/refresh"), firstCookie)
                        .header(HttpHeaders.ORIGIN, ALLOWED_ORIGIN)
                        // A body must be ignored; the cookie is the only credential.
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"refresh_token\":\"attacker-body-token\"}"))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode refreshedJson = json(refreshed);
        CONTRACT.assertValid("AuthSession", refreshedJson);
        assertThat(refreshedJson.has("refresh_token")).isFalse();
        String rotatedCookie = AuthCookieTestSupport.value(refreshed);
        assertThat(rotatedCookie).isNotBlank().isNotEqualTo(firstCookie);
        AuthSessionResponse rotated = objectMapper.readValue(
                refreshed.getResponse().getContentAsString(), AuthSessionResponse.class);
        assertThat(rotated.accessToken()).isNotEqualTo(session.accessToken());
        assertThat(AuthCookieTestSupport.setCookie(refreshed))
                .contains("HttpOnly")
                .contains("SameSite=Lax")
                .contains("Path=/api/v1/auth")
                .contains("Max-Age=");

        // Rotation invalidates the previous cookie value.
        MvcResult stale = mockMvc.perform(AuthCookieTestSupport.withCookie(
                                post("/api/v1/auth/refresh"), firstCookie)
                        .header(HttpHeaders.ORIGIN, ALLOWED_ORIGIN))
                .andExpect(status().isUnauthorized())
                .andReturn();
        assertThat(json(stale).get("code").asText()).isEqualTo("INVALID_CREDENTIALS");

        MvcResult logout = mockMvc.perform(AuthCookieTestSupport.withCookie(
                                post("/api/v1/auth/logout"), rotatedCookie)
                        .header(HttpHeaders.ORIGIN, ALLOWED_ORIGIN))
                .andExpect(status().isNoContent())
                .andReturn();
        assertThat(logout.getResponse().getContentAsString()).isEmpty();
        String clearCookie = AuthCookieTestSupport.setCookie(logout);
        assertThat(clearCookie)
                .startsWith("sova_refresh=;")
                .contains("Max-Age=0")
                .contains("HttpOnly")
                .contains("Path=/api/v1/auth");

        MvcResult revoked = mockMvc.perform(AuthCookieTestSupport.withCookie(
                                post("/api/v1/auth/refresh"), rotatedCookie)
                        .header(HttpHeaders.ORIGIN, ALLOWED_ORIGIN))
                .andExpect(status().isUnauthorized())
                .andReturn();
        assertThat(json(revoked).get("code").asText()).isEqualTo("INVALID_CREDENTIALS");

        // Logout is idempotent and still clears a missing/stale cookie.
        assertThat(mockMvc.perform(post("/api/v1/auth/logout")
                        .header(HttpHeaders.ORIGIN, ALLOWED_ORIGIN))
                .andExpect(status().isNoContent())
                .andReturn().getResponse().getHeader(HttpHeaders.SET_COOKIE))
                .contains("Max-Age=0");
    }

    @Test
    void refreshWithoutCookieIs401AndDoesNotEchoAToken() throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/auth/refresh")
                        .header(HttpHeaders.ORIGIN, ALLOWED_ORIGIN))
                .andExpect(status().isUnauthorized())
                .andReturn();
        CONTRACT.assertValid("Error", json(result));
        assertThat(json(result).get("code").asText()).isEqualTo("INVALID_CREDENTIALS");
        assertThat(result.getResponse().getContentAsString()).doesNotContain("refresh_token");
    }

    @Test
    void foreignBrowserOriginIsRejectedForStateChangingAuthRequests() throws Exception {
        String email = uniqueEmail("csrf");
        UUID verificationId = registerId(email);
        String cookie = AuthCookieTestSupport.value(
                verify(verificationId, mail.lastFor(email).code()));

        for (String origin : new String[]{"https://evil.example", "null"}) {
            MvcResult refresh = mockMvc.perform(AuthCookieTestSupport.withCookie(
                                    post("/api/v1/auth/refresh"), cookie)
                            .header(HttpHeaders.ORIGIN, origin))
                    .andExpect(status().isForbidden())
                    .andReturn();
            assertThat(json(refresh).get("code").asText()).isEqualTo("CSRF_REJECTED");
            CONTRACT.assertValid("Error", json(refresh));
        }

        // Referer is used when Origin is absent.
        MvcResult referer = mockMvc.perform(post("/api/v1/auth/login")
                        .header(HttpHeaders.REFERER, "https://evil.example/steal")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "email", email, "password", PASSWORD))))
                .andExpect(status().isForbidden())
                .andReturn();
        assertThat(json(referer).get("code").asText()).isEqualTo("CSRF_REJECTED");

        // A configured SPA origin is accepted.
        mockMvc.perform(AuthCookieTestSupport.withCookie(post("/api/v1/auth/refresh"), cookie)
                        .header(HttpHeaders.ORIGIN, ALLOWED_ORIGIN))
                .andExpect(status().isOk());
    }

    @Test
    void corsPreflightAllowsTheConfiguredOriginWithCredentials() throws Exception {
        mockMvc.perform(options("/api/v1/auth/refresh")
                        .header(HttpHeaders.ORIGIN, ALLOWED_ORIGIN)
                        .header(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, "POST")
                        .header(HttpHeaders.ACCESS_CONTROL_REQUEST_HEADERS, "content-type"))
                .andExpect(status().isOk())
                .andExpect(header().string(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN,
                        ALLOWED_ORIGIN))
                .andExpect(header().string(HttpHeaders.ACCESS_CONTROL_ALLOW_CREDENTIALS, "true"))
                .andExpect(header().string(HttpHeaders.ACCESS_CONTROL_ALLOW_METHODS,
                        org.hamcrest.Matchers.containsString("POST")));

        mockMvc.perform(options("/api/v1/auth/refresh")
                        .header(HttpHeaders.ORIGIN, "https://evil.example")
                        .header(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, "POST"))
                .andExpect(status().isForbidden());
    }

    @Test
    void adminApiUsesTheCachedServiceAccountTokenAndNeverThePasswordGrant() throws Exception {
        String email = uniqueEmail("service-account");
        registerAndVerify(email);

        assertThat(KeycloakWireMock.serviceTokenRequests())
                .as("one cached client_credentials token covers the whole registration")
                .isEqualTo(1);
        assertThat(KeycloakWireMock.adminPasswordTokenRequests())
                .as("the legacy admin-password property must be ignored")
                .isZero();
    }

    @Test
    void serviceAccountTokenIsReacquiredOnceAfterAdmin401() throws Exception {
        registerAndVerify(uniqueEmail("svc-refresh-before"));
        assertThat(KeycloakWireMock.serviceTokenRequests()).isEqualTo(1);

        KeycloakWireMock.invalidateServiceToken();
        String email = uniqueEmail("svc-refresh-after");
        MvcResult register = registerResult(email, "Дмитрий");
        assertThat(register.getResponse().getStatus()).isEqualTo(202);
        assertThat(KeycloakWireMock.serviceTokenRequests())
                .as("a 401 on the cached token forces exactly one fresh acquisition")
                .isEqualTo(2);
        assertThat(KeycloakWireMock.adminPasswordTokenRequests()).isZero();
    }

    @Test
    void validationAndUnknownVerificationUseContractErrors() throws Exception {
        MvcResult weak = registerResult(uniqueEmail("weak"), "Дмитрий", "short");
        assertThat(weak.getResponse().getStatus()).isEqualTo(400);
        CONTRACT.assertValid("Error", json(weak));

        MvcResult unknown = verifyResult(UUID.randomUUID(), "123456");
        assertThat(unknown.getResponse().getStatus()).isEqualTo(404);
        CONTRACT.assertValid("Error", json(unknown));
    }

    @Test
    void logsNeverContainPasswordsCodesOrTokens(CapturedOutput output) throws Exception {
        String email = uniqueEmail("logs");
        UUID verificationId = registerId(email);
        String code = mail.lastFor(email).code();
        MvcResult verify = verify(verificationId, code);
        AuthSessionResponse session = objectMapper.readValue(
                verify.getResponse().getContentAsString(), AuthSessionResponse.class);

        assertThat(output).doesNotContain(PASSWORD);
        assertThat(output).doesNotContain(code);
        assertThat(output).doesNotContain(session.accessToken());
        String cookie = AuthCookieTestSupport.value(verify);
        assertThat(cookie).isNotBlank();
        assertThat(output).doesNotContain(cookie);
        assertThat(output).doesNotContain(KeycloakWireMock.SERVICE_CLIENT_SECRET);
    }

    // ------------------------------------------------------------------ helpers

    private AuthSessionResponse registerAndVerify(String email) throws Exception {
        UUID verificationId = registerId(email);
        return verifySession(verificationId, mail.lastFor(email).code());
    }

    private UUID registerId(String email) throws Exception {
        MvcResult result = register(email, "Дмитрий");
        assertThat(result.getResponse().getStatus()).isEqualTo(202);
        return UUID.fromString(json(result).get("verification_id").asText());
    }

    private MvcResult register(String email, String displayName) throws Exception {
        MvcResult result = registerResult(email, displayName);
        assertThat(result.getResponse().getStatus())
                .as("register response: %s; keycloak: %s", result.getResponse().getContentAsString(), KeycloakWireMock.events())
                .isEqualTo(202);
        return result;
    }

    private MvcResult registerResult(String email, String displayName) throws Exception {
        return registerResult(email, displayName, PASSWORD);
    }

    private MvcResult registerResult(String email, String displayName, String password)
            throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("email", email);
        body.put("display_name", displayName);
        body.put("password", password);
        return mockMvc.perform(post("/api/v1/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andReturn();
    }

    private MvcResult verifyResult(UUID verificationId, String code) throws Exception {
        return mockMvc.perform(post("/api/v1/auth/verify-email")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "verification_id", verificationId.toString(),
                                "code", code))))
                .andReturn();
    }

    private MvcResult verify(UUID verificationId, String code) throws Exception {
        MvcResult result = verifyResult(verificationId, code);
        assertThat(result.getResponse().getStatus()).isEqualTo(200);
        return result;
    }

    private AuthSessionResponse verifySession(UUID verificationId, String code) throws Exception {
        return objectMapper.readValue(verify(verificationId, code).getResponse()
                .getContentAsString(), AuthSessionResponse.class);
    }

    private MvcResult loginResult(String email, String password) throws Exception {
        return mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "email", email,
                                "password", password))))
                .andReturn();
    }

    private static String uniqueEmail(String prefix) {
        return prefix + "-" + UUID.randomUUID().toString().substring(0, 12) + "@krug.test";
    }

    private static String wrongCode(String correct) {
        int last = correct.charAt(correct.length() - 1) - '0';
        return correct.substring(0, correct.length() - 1) + ((last + 1) % 10);
    }
}
