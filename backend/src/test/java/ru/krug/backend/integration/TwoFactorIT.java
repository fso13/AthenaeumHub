package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

import ru.krug.backend.auth.domain.service.TotpCode;
import ru.krug.backend.support.AuthCookieTestSupport;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.KeycloakTestSupport;
import ru.krug.backend.support.KeycloakWireMock;
import ru.krug.backend.support.OpenApiContract;

/**
 * P0-4 / #82: TOTP authenticator setup/verify/disable, hashed recovery codes and the
 * enforced BFF login challenge. Real MockMvc + PostgreSQL + fake Keycloak password grant.
 */
@SpringBootTest(properties = {
        "krug.files.scan-enabled=false",
        "krug.files.gc-enabled=false",
        "krug.files.reconcile-enabled=false",
        "krug.content.key=profile-test-content-key-please-change-32",
        "krug.auth-bff.code.secret-key=two-factor-test-secret-key-please-change-32",
        "krug.auth-bff.keycloak.admin-password=two-factor-test-admin",
        "krug.auth-bff.cleanup.enabled=false"
})
@ActiveProfiles("keycloak")
class TwoFactorIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();
    private static final String PASSWORD = "VeryStrongPass123!";

    @DynamicPropertySource
    static void keycloak(DynamicPropertyRegistry registry) {
        registry.add("krug.auth-bff.keycloak.base-url", KeycloakWireMock::baseUrl);
        registry.add("krug.oidc.issuer", KeycloakWireMock::issuer);
        registry.add("krug.oidc.jwk-set-uri", KeycloakWireMock::jwksUri);
    }

    @BeforeEach
    void resetFakeIdp() {
        KeycloakWireMock.reset();
    }

    @Test
    void setupVerifyAndStatusNeverStoreOrRepeatThePlaintextSecret() throws Exception {
        KeycloakWireMock.TestUser idp = keycloakUser("2fa-setup");
        RequestPostProcessor auth = auth(idp);

        JsonNode setup = setup(auth, PASSWORD);
        CONTRACT.assertValid("TwoFactorSetup", setup);
        String secret = setup.get("secret").asText();
        assertThat(secret).hasSize(27);
        assertThat(setup.get("otpauth_uri").asText())
                .startsWith("otpauth://totp/").contains("secret=" + secret)
                .contains("algorithm=SHA1").contains("digits=6").contains("period=30");
        assertThat(setup.get("qr_payload").asText()).isEqualTo(setup.get("otpauth_uri").asText());

        JsonNode verified = json(mockMvc.perform(authed(post("/api/v1/me/2fa/verify"), auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("code", code(secret)))))
                .andExpect(status().isOk()).andReturn());
        CONTRACT.assertValid("TwoFactorStatus", verified);
        assertThat(verified.get("enabled").asBoolean()).isTrue();
        assertThat(verified.get("enabled_at").isNull()).isFalse();
        assertThat(verified.get("recovery_codes_remaining").asInt()).isZero();

        JsonNode status = json(mockMvc.perform(authed(get("/api/v1/me/2fa"), auth))
                .andExpect(status().isOk()).andReturn());
        CONTRACT.assertValid("TwoFactorStatus", status);
        assertThat(status.get("enabled").asBoolean()).isTrue();
        assertThat(status.toString()).doesNotContain(secret);

        byte[] stored = migrator().queryForObject("""
                SELECT secret_ciphertext FROM auth.user_totp WHERE user_id = ?
                """, byte[].class, localUserId(idp));
        assertThat(stored).isNotNull();
        assertThat(new String(stored, StandardCharsets.UTF_8)).doesNotContain(secret);
        assertThat(stored).isNotEqualTo(secret.getBytes(StandardCharsets.UTF_8));

        Map<String, Object> event = migrator().queryForMap("""
                SELECT metadata::text AS metadata FROM audit.audit_events
                 WHERE action = '2fa.enabled' AND actor_id = ?
                 ORDER BY created_at DESC LIMIT 1
                """, localUserId(idp));
        assertThat(String.valueOf(event.get("metadata"))).doesNotContain(secret)
                .doesNotContain("otpauth");

        mockMvc.perform(authed(post("/api/v1/me/2fa/setup"), auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("password", PASSWORD))))
                .andExpect(status().isConflict());
    }

    @Test
    void setupRequiresPasswordReauthenticationBoundToTheCaller() throws Exception {
        KeycloakWireMock.TestUser idp = keycloakUser("2fa-reauth");
        RequestPostProcessor auth = auth(idp);

        MvcResult wrong = mockMvc.perform(authed(post("/api/v1/me/2fa/setup"), auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("password", "wrong-password"))))
                .andExpect(status().isForbidden()).andReturn();
        CONTRACT.assertValid("Error", json(wrong));
        assertThat(json(wrong).get("code").asText()).isEqualTo("REAUTH_FAILED");
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM auth.user_totp WHERE user_id = ?", Long.class,
                localUserId(idp))).isZero();

        setup(auth, PASSWORD);
    }

    @Test
    void recoveryCodesAreReturnedOnceAndStoredOnlyAsHashes() throws Exception {
        KeycloakWireMock.TestUser idp = keycloakUser("2fa-recovery");
        RequestPostProcessor auth = auth(idp);
        String secret = setupAndVerify(auth);

        MvcResult result = mockMvc.perform(authed(post("/api/v1/me/2fa/recovery-codes"), auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("password", PASSWORD))))
                .andExpect(status().isOk()).andReturn();
        JsonNode body = json(result);
        CONTRACT.assertValid("TwoFactorRecoveryCodes", body);
        assertThat(body.get("codes")).hasSize(10);
        assertThat(body.get("remaining").asInt()).isEqualTo(10);
        assertThat(result.getResponse().getContentAsString()).doesNotContain(secret);

        List<String> storedHashes = migrator().queryForList("""
                SELECT code_hash FROM auth.user_recovery_codes WHERE user_id = ?
                """, String.class, localUserId(idp));
        assertThat(storedHashes).hasSize(10).allSatisfy(hash ->
                assertThat(hash).hasSize(64).matches("[a-f0-9]{64}"));
        for (JsonNode code : body.get("codes")) {
            assertThat(storedHashes).doesNotContain(code.asText());
        }

        JsonNode status = json(mockMvc.perform(authed(get("/api/v1/me/2fa"), auth))
                .andExpect(status().isOk()).andReturn());
        assertThat(status.get("recovery_codes_remaining").asInt()).isEqualTo(10);
    }

    @Test
    void disableRequiresPasswordAndAValidSecondFactor() throws Exception {
        KeycloakWireMock.TestUser idp = keycloakUser("2fa-disable");
        RequestPostProcessor auth = auth(idp);
        String secret = setupAndVerify(auth);
        mockMvc.perform(authed(post("/api/v1/me/2fa/recovery-codes"), auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("password", PASSWORD))))
                .andExpect(status().isOk());

        MvcResult wrongPassword = mockMvc.perform(authed(delete("/api/v1/me/2fa"), auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "password", "wrong-password", "code", code(secret)))))
                .andExpect(status().isForbidden()).andReturn();
        assertThat(json(wrongPassword).get("code").asText()).isEqualTo("REAUTH_FAILED");

        MvcResult wrongCode = mockMvc.perform(authed(delete("/api/v1/me/2fa"), auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "password", PASSWORD, "code", "000000"))))
                .andExpect(status().isUnprocessableEntity()).andReturn();
        assertThat(json(wrongCode).get("code").asText())
                .isEqualTo("TWO_FACTOR_CODE_INVALID");

        mockMvc.perform(authed(delete("/api/v1/me/2fa"), auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "password", PASSWORD, "code", nextCode(secret)))))
                .andExpect(status().isNoContent());
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM auth.user_totp WHERE user_id = ?", Long.class,
                localUserId(idp))).isZero();
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM auth.user_recovery_codes WHERE user_id = ?", Long.class,
                localUserId(idp))).isZero();
    }

    @Test
    void loginWithEnabledTwoFactorReturnsAOneTimeChallengeThenSession() throws Exception {
        KeycloakWireMock.TestUser idp = keycloakUser("2fa-login");
        RequestPostProcessor auth = auth(idp);
        String secret = setupAndVerify(auth);

        MvcResult challengeResult = login(idp);
        assertThat(challengeResult.getResponse().getStatus()).isEqualTo(202);
        JsonNode challenge = json(challengeResult);
        CONTRACT.assertValid("AuthTwoFactorChallenge", challenge);
        assertThat(challenge.get("methods").toString()).contains("TOTP", "RECOVERY_CODE");
        assertThat(challengeResult.getResponse().getContentAsString())
                .doesNotContain("access_token", "refresh_token", secret);
        String challengeId = challenge.get("challenge_id").asText();

        MvcResult wrong = mockMvc.perform(post("/api/v1/auth/2fa/verify")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "challenge_id", challengeId, "code", "000000"))))
                .andExpect(status().isUnprocessableEntity()).andReturn();
        assertThat(json(wrong).get("code").asText()).isEqualTo("TWO_FACTOR_CODE_INVALID");

        MvcResult session = mockMvc.perform(post("/api/v1/auth/2fa/verify")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "challenge_id", challengeId, "code", nextCode(secret)))))
                .andExpect(status().isOk()).andReturn();
        JsonNode body = json(session);
        CONTRACT.assertValid("AuthSession", body);
        assertThat(body.get("access_token").asText()).isNotBlank();
        // #103: the refresh token is an HttpOnly cookie, never a JSON field.
        assertThat(body.has("refresh_token")).isFalse();
        assertThat(AuthCookieTestSupport.value(session)).isNotBlank();
        assertThat(AuthCookieTestSupport.setCookie(session))
                .contains("HttpOnly")
                .contains("SameSite=Lax")
                .contains("Path=/api/v1/auth")
                .doesNotContain("Secure");
        assertThat(body.at("/user/email").asText()).isEqualTo(idp.email());

        mockMvc.perform(post("/api/v1/auth/2fa/verify")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "challenge_id", challengeId, "code", nextCode(secret)))))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void recoveryCodeCompletesLoginAndIsSingleUse() throws Exception {
        KeycloakWireMock.TestUser idp = keycloakUser("2fa-recovery-login");
        RequestPostProcessor auth = auth(idp);
        setupAndVerify(auth);
        JsonNode codes = recoveryCodes(auth);
        String first = codes.get("codes").get(0).asText();
        String second = codes.get("codes").get(1).asText();

        String challengeId = json(login(idp)).get("challenge_id").asText();
        mockMvc.perform(post("/api/v1/auth/2fa/verify")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "challenge_id", challengeId, "code", first))))
                .andExpect(status().isOk());

        String retryId = json(login(idp)).get("challenge_id").asText();
        MvcResult reused = mockMvc.perform(post("/api/v1/auth/2fa/verify")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "challenge_id", retryId, "code", first))))
                .andExpect(status().isUnprocessableEntity()).andReturn();
        assertThat(json(reused).get("code").asText())
                .isEqualTo("TWO_FACTOR_RECOVERY_CODE_INVALID");

        String finalId = json(login(idp)).get("challenge_id").asText();
        mockMvc.perform(post("/api/v1/auth/2fa/verify")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "challenge_id", finalId, "code", second))))
                .andExpect(status().isOk());
    }

    @Test
    void challengeIsDiscardedAfterMaxAttempts() throws Exception {
        KeycloakWireMock.TestUser idp = keycloakUser("2fa-attempts");
        RequestPostProcessor auth = auth(idp);
        setupAndVerify(auth);
        String challengeId = json(login(idp)).get("challenge_id").asText();

        for (int attempt = 0; attempt < 5; attempt++) {
            mockMvc.perform(post("/api/v1/auth/2fa/verify")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(Map.of(
                                    "challenge_id", challengeId, "code", "000000"))))
                    .andExpect(status().isUnprocessableEntity());
        }
        mockMvc.perform(post("/api/v1/auth/2fa/verify")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "challenge_id", challengeId, "code", "000000"))))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void acceptedTotpStepCannotBeReplayedAtLogin() throws Exception {
        KeycloakWireMock.TestUser idp = keycloakUser("2fa-replay");
        RequestPostProcessor auth = auth(idp);
        String secret = setupAndVerify(auth);
        // Pin the last accepted step to the current one, so the same code is a replay
        // regardless of a 30-second boundary between setup and login.
        long currentStep = Instant.now().getEpochSecond() / 30;
        migrator().update("UPDATE auth.user_totp SET last_used_step = ? WHERE user_id = ?",
                currentStep, localUserId(idp));
        String challengeId = json(login(idp)).get("challenge_id").asText();
        MvcResult replay = mockMvc.perform(post("/api/v1/auth/2fa/verify")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "challenge_id", challengeId, "code", code(secret)))))
                .andExpect(status().isUnprocessableEntity()).andReturn();
        assertThat(json(replay).get("code").asText()).isEqualTo("TWO_FACTOR_CODE_INVALID");
    }

    @Test
    void loginWithoutTwoFactorStillReturnsASessionDirectly() throws Exception {
        KeycloakWireMock.TestUser idp = keycloakUser("2fa-off");
        MvcResult result = login(idp);
        assertThat(result.getResponse().getStatus()).isEqualTo(200);
        CONTRACT.assertValid("AuthSession", json(result));
    }

    @Test
    void twoFactorEndpointsRequireAuthentication() throws Exception {
        mockMvc.perform(get("/api/v1/me/2fa")).andExpect(status().isUnauthorized());
        mockMvc.perform(post("/api/v1/me/2fa/setup")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"password\":\"x\"}"))
                .andExpect(status().isUnauthorized());
        mockMvc.perform(post("/api/v1/me/2fa/verify")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"code\":\"000000\"}"))
                .andExpect(status().isUnauthorized());
        mockMvc.perform(post("/api/v1/me/2fa/recovery-codes")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"password\":\"x\"}"))
                .andExpect(status().isUnauthorized());
        mockMvc.perform(delete("/api/v1/me/2fa")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"password\":\"x\",\"code\":\"000000\"}"))
                .andExpect(status().isUnauthorized());
    }


    @Test
    void statusIsDisabledBeforeSetup() throws Exception {
        KeycloakWireMock.TestUser idp = keycloakUser("2fa-status-off");
        JsonNode status = json(mockMvc.perform(authed(get("/api/v1/me/2fa"), auth(idp)))
                .andExpect(status().isOk()).andReturn());
        CONTRACT.assertValid("TwoFactorStatus", status);
        assertThat(status.get("enabled").asBoolean()).isFalse();
        assertThat(status.get("recovery_codes_remaining").asInt()).isZero();
    }

    @Test
    void verifyBeforeSetupIsAConflict() throws Exception {
        KeycloakWireMock.TestUser idp = keycloakUser("2fa-verify-before-setup");
        MvcResult result = mockMvc.perform(authed(post("/api/v1/me/2fa/verify"), auth(idp))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"code\":\"123456\"}"))
                .andExpect(status().isConflict()).andReturn();
        assertThat(json(result).get("code").asText()).isEqualTo("TWO_FACTOR_NOT_SETUP");
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "12345", "abcdef", "1234567"})
    void malformedVerifyPayloadIsRejectedByValidation(String code) throws Exception {
        KeycloakWireMock.TestUser idp = keycloakUser("2fa-malformed");
        MvcResult result = mockMvc.perform(authed(post("/api/v1/me/2fa/verify"), auth(idp))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("code", code))))
                .andReturn();
        assertThat(result.getResponse().getStatus()).isEqualTo(400);
        assertThat(json(result).get("code").asText()).isEqualTo("VALIDATION_FAILED");
    }

    @Test
    void recoveryCodesRequireAnEnabledAuthenticator() throws Exception {
        KeycloakWireMock.TestUser idp = keycloakUser("2fa-recovery-disabled");
        MvcResult result = mockMvc.perform(authed(post("/api/v1/me/2fa/recovery-codes"), auth(idp))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("password", PASSWORD))))
                .andExpect(status().isConflict()).andReturn();
        assertThat(json(result).get("code").asText()).isEqualTo("TWO_FACTOR_NOT_ENABLED");
    }

    @Test
    void regeneratingRecoveryCodesInvalidatesThePreviousSet() throws Exception {
        KeycloakWireMock.TestUser idp = keycloakUser("2fa-recovery-rotate");
        RequestPostProcessor auth = auth(idp);
        setupAndVerify(auth);
        JsonNode first = recoveryCodes(auth);
        JsonNode second = recoveryCodes(auth);
        assertThat(first.get("codes")).isNotEqualTo(second.get("codes"));
        List<String> hashes = migrator().queryForList("""
                SELECT code_hash FROM auth.user_recovery_codes WHERE user_id = ?
                """, String.class, localUserId(idp));
        assertThat(hashes).hasSize(10);
        for (JsonNode code : first.get("codes")) {
            assertThat(hashes).doesNotContain(ru.krug.backend.auth.domain.service.RecoveryCodes
                    .hash(localUserId(idp), code.asText()));
        }
    }

    // ---------------------------------------------------------------- helpers

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

    private JsonNode setup(RequestPostProcessor auth, String password) throws Exception {
        MvcResult result = mockMvc.perform(authed(post("/api/v1/me/2fa/setup"), auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("password", password))))
                .andExpect(status().isOk()).andReturn();
        return json(result);
    }

    private String setupAndVerify(RequestPostProcessor auth) throws Exception {
        String secret = setup(auth, PASSWORD).get("secret").asText();
        mockMvc.perform(authed(post("/api/v1/me/2fa/verify"), auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("code", code(secret)))))
                .andExpect(status().isOk());
        return secret;
    }

    private JsonNode recoveryCodes(RequestPostProcessor auth) throws Exception {
        return json(mockMvc.perform(authed(post("/api/v1/me/2fa/recovery-codes"), auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("password", PASSWORD))))
                .andExpect(status().isOk()).andReturn());
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
