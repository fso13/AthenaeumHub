package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

import ru.krug.backend.auth.domain.service.TotpCode;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.KeycloakTestSupport;
import ru.krug.backend.support.KeycloakWireMock;
import ru.krug.backend.support.MockMailSender;
import ru.krug.backend.support.OpenApiContract;
import ru.krug.backend.support.TestMailConfig;

/**
 * #91 server-side 2FA policy: global require_2fa switch, ENROLL challenge for an account
 * without a TOTP authenticator, existing TOTP challenge, refresh hardening and that email
 * verification cannot bypass the policy. Real MockMvc + PostgreSQL + fake Keycloak.
 */
@SpringBootTest(properties = {
        "krug.files.scan-enabled=false",
        "krug.files.gc-enabled=false",
        "krug.files.reconcile-enabled=false",
        "krug.content.key=two-factor-policy-test-content-key-32",
        "krug.auth-bff.code.secret-key=two-factor-policy-test-secret-key-32",
        "krug.auth-bff.keycloak.admin-password=two-factor-policy-test-admin",
        "krug.auth-bff.cleanup.enabled=false",
        "krug.auth-bff.rate-limit.register-per-email=100",
        "krug.auth-bff.rate-limit.register-per-ip=1000",
        "krug.auth-bff.rate-limit.login-per-email=100",
        "krug.auth-bff.rate-limit.login-per-ip=1000",
        "krug.auth-bff.rate-limit.two-factor-per-user=100",
        "krug.auth-bff.rate-limit.two-factor-per-ip=1000"
})
@ActiveProfiles("keycloak")
@Import(TestMailConfig.class)
class TwoFactorPolicyIT extends IntegrationTestBase {

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
    void reset() {
        KeycloakWireMock.reset();
        mail.clear();
        migrator().update("UPDATE ops.system_settings SET registration_open = true WHERE id = 1");
        setPolicy(false);
    }

    @AfterEach
    void cleanup() {
        setPolicy(false);
    }

    @Test
    void policyOffKeepsTheExistingDirectLogin() throws Exception {
        KeycloakWireMock.TestUser idp = keycloakUser("policy-off");
        MvcResult result = login(idp);
        assertThat(result.getResponse().getStatus()).isEqualTo(200);
        CONTRACT.assertValid("AuthSession", json(result));
    }

    @Test
    void policyOnWithAuthenticatorReturnsTheTotpChallenge() throws Exception {
        KeycloakWireMock.TestUser idp = keycloakUser("policy-totp");
        String secret = setupAndVerify(auth(idp));
        setPolicy(true);

        MvcResult challengeResult = login(idp);
        assertThat(challengeResult.getResponse().getStatus()).isEqualTo(202);
        JsonNode challenge = json(challengeResult);
        CONTRACT.assertValid("AuthTwoFactorChallenge", challenge);
        assertThat(challenge.get("mode").asText()).isEqualTo("TOTP");
        assertThat(challenge.get("methods").toString()).contains("TOTP", "RECOVERY_CODE");
        assertThat(challengeResult.getResponse().getContentAsString())
                .doesNotContain("access_token", "refresh_token", secret);

        MvcResult session = mockMvc.perform(post("/api/v1/auth/2fa/verify")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "challenge_id", challenge.get("challenge_id").asText(),
                                "code", nextCode(secret)))))
                .andExpect(status().isOk()).andReturn();
        JsonNode body = json(session);
        CONTRACT.assertValid("AuthSession", body);
        assertThat(body.get("refresh_token").asText()).isNotBlank();

        // The completed challenge marks the refresh token: rotation is allowed.
        MvcResult refreshed = mockMvc.perform(post("/api/v1/auth/refresh")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("refresh_token", body.get("refresh_token").asText()))))
                .andExpect(status().isOk()).andReturn();
        CONTRACT.assertValid("AuthSession", json(refreshed));
    }

    @Test
    void policyOnWithoutAuthenticatorEnrollsThenIssuesTheSession() throws Exception {
        KeycloakWireMock.TestUser idp = keycloakUser("policy-enroll");
        enablePolicyThroughAdminApi(idp);

        MvcResult challengeResult = login(idp);
        assertThat(challengeResult.getResponse().getStatus()).isEqualTo(202);
        JsonNode challenge = json(challengeResult);
        CONTRACT.assertValid("AuthTwoFactorChallenge", challenge);
        assertThat(challenge.get("mode").asText()).isEqualTo("ENROLL");
        assertThat(challenge.get("methods").toString()).contains("TOTP");
        assertThat(challengeResult.getResponse().getContentAsString())
                .doesNotContain("access_token", "refresh_token");
        String challengeId = challenge.get("challenge_id").asText();

        JsonNode setup = enrollStart(challengeId);
        CONTRACT.assertValid("TwoFactorSetup", setup);
        String secret = setup.get("secret").asText();
        assertThat(secret).hasSize(27);
        assertThat(setup.get("otpauth_uri").asText())
                .startsWith("otpauth://totp/").contains("secret=" + secret);

        UUID userId = localUserId(idp);
        byte[] ciphertext = migrator().queryForObject(
                "SELECT secret_ciphertext FROM auth.user_totp WHERE user_id = ?",
                byte[].class, userId);
        assertThat(ciphertext).isNotNull();
        assertThat(new String(ciphertext, StandardCharsets.UTF_8)).doesNotContain(secret);
        assertThat(migrator().queryForObject(
                "SELECT enabled_at FROM auth.user_totp WHERE user_id = ?",
                java.sql.Timestamp.class, userId)).isNull();

        MvcResult wrong = mockMvc.perform(post("/api/v1/auth/2fa/enroll/verify")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "challenge_id", challengeId, "code", "000000"))))
                .andExpect(status().isUnprocessableEntity()).andReturn();
        assertThat(json(wrong).get("code").asText()).isEqualTo("TWO_FACTOR_CODE_INVALID");
        assertThat(migrator().queryForObject(
                "SELECT enabled_at FROM auth.user_totp WHERE user_id = ?",
                java.sql.Timestamp.class, userId)).isNull();

        MvcResult session = mockMvc.perform(post("/api/v1/auth/2fa/enroll/verify")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "challenge_id", challengeId, "code", code(secret)))))
                .andExpect(status().isOk()).andReturn();
        JsonNode sessionBody = json(session);
        CONTRACT.assertValid("AuthSession", sessionBody);
        assertThat(sessionBody.at("/user/email").asText()).isEqualTo(idp.email());
        assertThat(migrator().queryForObject(
                "SELECT enabled_at FROM auth.user_totp WHERE user_id = ?",
                java.sql.Timestamp.class, userId)).isNotNull();

        // Single-use: the same challenge can never mint another session.
        mockMvc.perform(post("/api/v1/auth/2fa/enroll/verify")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "challenge_id", challengeId, "code", nextCode(secret)))))
                .andExpect(status().isUnauthorized());

        // The next login is the normal TOTP challenge, not ENROLL.
        JsonNode nextChallenge = json(login(idp));
        assertThat(nextChallenge.get("mode").asText()).isEqualTo("TOTP");

        String metadata = migrator().queryForObject("""
                SELECT string_agg(metadata::text, ' ') FROM audit.audit_events
                 WHERE actor_id = ? AND action LIKE '2fa.enrollment.%'
                """, String.class, userId);
        assertThat(metadata).doesNotContain(secret).doesNotContain("otpauth");

        MvcResult refreshed = mockMvc.perform(post("/api/v1/auth/refresh")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "refresh_token", sessionBody.get("refresh_token").asText()))))
                .andExpect(status().isOk()).andReturn();
        CONTRACT.assertValid("AuthSession", json(refreshed));
    }

    @Test
    void enrollmentChallengeIsAttemptCappedAndHasTheRightMode() throws Exception {
        KeycloakWireMock.TestUser idp = keycloakUser("policy-attempts");
        setPolicy(true);
        String challengeId = json(login(idp)).get("challenge_id").asText();
        String secret = enrollStart(challengeId).get("secret").asText();

        // An ENROLL challenge must not be accepted by the TOTP completion endpoint.
        MvcResult wrongEndpoint = mockMvc.perform(post("/api/v1/auth/2fa/verify")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "challenge_id", challengeId, "code", "000000"))))
                .andExpect(status().isConflict()).andReturn();
        assertThat(json(wrongEndpoint).get("code").asText())
                .isEqualTo("TWO_FACTOR_ENROLLMENT_REQUIRED");

        for (int attempt = 0; attempt < 5; attempt++) {
            mockMvc.perform(post("/api/v1/auth/2fa/enroll/verify")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(Map.of(
                                    "challenge_id", challengeId, "code", "000000"))))
                    .andExpect(status().isUnprocessableEntity());
        }
        mockMvc.perform(post("/api/v1/auth/2fa/enroll/verify")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "challenge_id", challengeId, "code", code(secret)))))
                .andExpect(status().isUnauthorized());
        assertThat(migrator().queryForObject(
                "SELECT enabled_at FROM auth.user_totp WHERE user_id = ?",
                java.sql.Timestamp.class, localUserId(idp))).isNull();

        // A fresh login restarts the flow and reuses the still-pending secret.
        String nextId = json(login(idp)).get("challenge_id").asText();
        assertThat(enrollStart(nextId).get("secret").asText()).isEqualTo(secret);
    }

    @Test
    void enrollEndpointsRejectATotpChallenge() throws Exception {
        KeycloakWireMock.TestUser idp = keycloakUser("policy-wrong-mode");
        setupAndVerify(auth(idp));
        setPolicy(true);
        String challengeId = json(login(idp)).get("challenge_id").asText();

        MvcResult result = mockMvc.perform(post("/api/v1/auth/2fa/enroll/start")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("challenge_id", challengeId))))
                .andExpect(status().isUnauthorized()).andReturn();
        assertThat(json(result).get("code").asText())
                .isEqualTo("TWO_FACTOR_CHALLENGE_INVALID");

        MvcResult verify = mockMvc.perform(post("/api/v1/auth/2fa/enroll/verify")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "challenge_id", challengeId, "code", "123456"))))
                .andExpect(status().isUnauthorized()).andReturn();
        assertThat(json(verify).get("code").asText())
                .isEqualTo("TWO_FACTOR_CHALLENGE_INVALID");
    }

    @Test
    void refreshCannotExtendAPasswordOnlySession() throws Exception {
        KeycloakWireMock.TestUser idp = keycloakUser("policy-refresh");
        MvcResult login = login(idp);
        assertThat(login.getResponse().getStatus()).isEqualTo(200);
        String refreshToken = json(login).get("refresh_token").asText();

        setPolicy(true);

        MvcResult refused = mockMvc.perform(post("/api/v1/auth/refresh")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("refresh_token", refreshToken))))
                .andExpect(status().isForbidden()).andReturn();
        JsonNode error = json(refused);
        CONTRACT.assertValid("Error", error);
        assertThat(error.get("code").asText()).isEqualTo("TWO_FACTOR_REQUIRED");
        assertThat(refused.getResponse().getContentAsString())
                .doesNotContain("access_token", "refresh_token");

        String challengeId = json(login(idp)).get("challenge_id").asText();
        String secret = enrollStart(challengeId).get("secret").asText();
        JsonNode enrolled = json(mockMvc.perform(post("/api/v1/auth/2fa/enroll/verify")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "challenge_id", challengeId, "code", code(secret)))))
                .andExpect(status().isOk()).andReturn());

        MvcResult rotated = mockMvc.perform(post("/api/v1/auth/refresh")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "refresh_token", enrolled.get("refresh_token").asText()))))
                .andExpect(status().isOk()).andReturn();
        CONTRACT.assertValid("AuthSession", json(rotated));
    }

    @Test
    void emailVerificationCannotBypassThePolicy() throws Exception {
        setPolicy(true);
        String email = KeycloakTestSupport.uniqueEmail("policy-email");
        MvcResult registered = mockMvc.perform(post("/api/v1/auth/register")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "email", email,
                                "display_name", "Policy Email",
                                "password", PASSWORD))))
                .andExpect(status().isAccepted()).andReturn();
        UUID verificationId = UUID.fromString(
                json(registered).get("verification_id").asText());

        MvcResult verified = mockMvc.perform(post("/api/v1/auth/verify-email")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "verification_id", verificationId,
                                "code", mail.lastFor(email).code()))))
                .andReturn();
        assertThat(verified.getResponse().getStatus()).isEqualTo(202);
        JsonNode challenge = json(verified);
        CONTRACT.assertValid("AuthTwoFactorChallenge", challenge);
        assertThat(challenge.get("mode").asText()).isEqualTo("ENROLL");
        assertThat(verified.getResponse().getContentAsString())
                .doesNotContain("access_token", "refresh_token");

        String challengeId = challenge.get("challenge_id").asText();
        String secret = enrollStart(challengeId).get("secret").asText();
        mockMvc.perform(post("/api/v1/auth/2fa/enroll/verify")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "challenge_id", challengeId, "code", code(secret)))))
                .andExpect(status().isOk());
    }

    // ---------------------------------------------------------------- helpers

    private void setPolicy(boolean required) {
        migrator().update("UPDATE ops.system_settings SET require_2fa = ? WHERE id = 1",
                required);
    }

    private void enablePolicyThroughAdminApi(KeycloakWireMock.TestUser idp) throws Exception {
        // Seed the local user with a normal (policy-off) login, then use the admin surface
        // with that user's Keycloak JWT to flip the installation policy.
        assertThat(login(idp).getResponse().getStatus()).isEqualTo(200);
        UUID userId = localUserId(idp);
        migrator().update("UPDATE auth.users SET is_platform_admin = false "
                + "WHERE is_platform_admin");
        migrator().update("UPDATE auth.users SET is_platform_admin = true WHERE id = ?", userId);
        MvcResult patched = mockMvc.perform(authed(patch("/api/v1/admin/settings"), auth(idp))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"require_2fa\":true}"))
                .andExpect(status().isOk()).andReturn();
        assertThat(json(patched).get("require_2fa").asBoolean()).isTrue();
        assertThat(migrator().queryForObject(
                "SELECT require_2fa FROM ops.system_settings WHERE id = 1", Boolean.class))
                .isTrue();
    }

    private KeycloakWireMock.TestUser keycloakUser(String prefix) {
        return KeycloakWireMock.putUser(KeycloakTestSupport.uniqueEmail(prefix), "Idp Initial",
                PASSWORD, true, true);
    }

    private static RequestPostProcessor auth(KeycloakWireMock.TestUser user) {
        return KeycloakTestSupport.keycloakJwt(user.id().toString(), user.email(), "profile",
                "Idp Initial");
    }

    private UUID localUserId(KeycloakWireMock.TestUser user) {
        return migrator().queryForObject(
                "SELECT user_id FROM auth.user_identities WHERE provider = 'keycloak' AND subject = ?",
                UUID.class, user.id().toString());
    }

    private String setupAndVerify(RequestPostProcessor auth) throws Exception {
        String secret = json(mockMvc.perform(authed(post("/api/v1/me/2fa/setup"), auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("password", PASSWORD))))
                .andExpect(status().isOk()).andReturn()).get("secret").asText();
        mockMvc.perform(authed(post("/api/v1/me/2fa/verify"), auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("code", code(secret)))))
                .andExpect(status().isOk());
        return secret;
    }

    private JsonNode enrollStart(String challengeId) throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/auth/2fa/enroll/start")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("challenge_id", challengeId))))
                .andExpect(status().isOk()).andReturn();
        return json(result);
    }

    private MvcResult login(KeycloakWireMock.TestUser user) throws Exception {
        return mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "email", user.email(), "password", PASSWORD))))
                .andReturn();
    }

    private static String code(String secret) {
        return TotpCode.generate(secret, Instant.now().getEpochSecond());
    }

    private static String nextCode(String secret) {
        return TotpCode.generate(secret, Instant.now().getEpochSecond() + 30);
    }

    private org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder authed(
            org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder builder,
            RequestPostProcessor auth) {
        return builder.with(auth);
    }
}
