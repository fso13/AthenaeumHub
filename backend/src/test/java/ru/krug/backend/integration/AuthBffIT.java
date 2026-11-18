package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
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
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.auth.api.dto.AuthRegisterResponse;
import ru.krug.backend.auth.api.dto.AuthSessionResponse;
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
        assertThat(session.refreshToken()).isNotBlank();
        assertThat(session.tokenType()).isEqualTo("Bearer");

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
    void refreshRotatesAndLogoutRevokes() throws Exception {
        String email = uniqueEmail("refresh");
        AuthSessionResponse session = registerAndVerify(email);

        MvcResult refreshed = mockMvc.perform(post("/api/v1/auth/refresh")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("refresh_token", session.refreshToken()))))
                .andExpect(status().isOk())
                .andReturn();
        CONTRACT.assertValid("AuthSession", json(refreshed));
        AuthSessionResponse rotated = objectMapper.readValue(
                refreshed.getResponse().getContentAsString(), AuthSessionResponse.class);
        assertThat(rotated.accessToken()).isNotEqualTo(session.accessToken());
        assertThat(rotated.refreshToken()).isNotEqualTo(session.refreshToken());

        MvcResult logout = mockMvc.perform(post("/api/v1/auth/logout")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("refresh_token", rotated.refreshToken()))))
                .andExpect(status().isNoContent())
                .andReturn();
        assertThat(logout.getResponse().getContentAsString()).isEmpty();

        MvcResult revoked = mockMvc.perform(post("/api/v1/auth/refresh")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("refresh_token", rotated.refreshToken()))))
                .andReturn();
        assertThat(revoked.getResponse().getStatus()).isEqualTo(401);
        assertThat(json(revoked).get("code").asText()).isEqualTo("INVALID_CREDENTIALS");

        // Logout is idempotent.
        assertThat(mockMvc.perform(post("/api/v1/auth/logout")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("refresh_token", "not-a-token"))))
                .andReturn().getResponse().getStatus()).isEqualTo(204);
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
        AuthSessionResponse session = verifySession(verificationId, code);

        assertThat(output).doesNotContain(PASSWORD);
        assertThat(output).doesNotContain(code);
        assertThat(output).doesNotContain(session.accessToken());
        assertThat(output).doesNotContain(session.refreshToken());
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
