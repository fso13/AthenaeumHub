package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.KeycloakTestSupport;
import ru.krug.backend.support.KeycloakWireMock;
import ru.krug.backend.support.OpenApiContract;

/**
 * Issue #72: self-service profile PATCH (bio/phone/display name) and Keycloak session
 * list/revoke. Runs the real REST/DB/audit stack against the fake Keycloak Admin API.
 *
 * <p>Every test addresses the caller only: there is deliberately no user id in the URL,
 * so the ownership assertion is "another user's session id is 404 and remains listed for
 * its owner".</p>
 */
@SpringBootTest(properties = {
        "krug.files.scan-enabled=false",
        "krug.files.gc-enabled=false",
        "krug.files.reconcile-enabled=false",
        "krug.content.key=profile-test-content-key-please-change-32",
        "krug.auth-bff.keycloak.admin-password=profile-test-admin",
        "krug.auth-bff.cleanup.enabled=false"
})
@ActiveProfiles("keycloak")
class ProfileIT extends IntegrationTestBase {

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
    void patchUpdatesOnlyProfileFieldsAndAuditsFieldNames() throws Exception {
        KeycloakWireMock.TestUser idp = keycloakUser("profile-update");
        RequestPostProcessor auth = auth(idp, null);
        UUID userId = meId(auth);

        MvcResult patched = mockMvc.perform(patch("/api/v1/me").with(auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "display_name", "Новое имя",
                                "bio", "Люблю шифрование и котиков",
                                "phone", "+7 (999) 123-45-67"))))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode body = json(patched);
        CONTRACT.assertValid("AuthUser", body);
        assertThat(body.get("id").asText()).isEqualTo(userId.toString());
        assertThat(body.get("display_name").asText()).isEqualTo("Новое имя");
        assertThat(body.get("bio").asText()).isEqualTo("Люблю шифрование и котиков");
        assertThat(body.get("phone").asText()).isEqualTo("+7 (999) 123-45-67");
        assertThat(body.get("email").asText()).isEqualTo(idp.email());

        JsonNode me = json(mockMvc.perform(get("/api/v1/me").with(auth))
                .andExpect(status().isOk()).andReturn());
        CONTRACT.assertValid("MeResponse", me);
        assertThat(me.at("/user/display_name").asText()).isEqualTo("Новое имя");
        assertThat(me.at("/user/bio").asText()).isEqualTo("Люблю шифрование и котиков");
        assertThat(me.at("/user/phone").asText()).isEqualTo("+7 (999) 123-45-67");
        assertThat(me.at("/user/email").asText()).isEqualTo(idp.email());

        Map<String, Object> row = migrator().queryForMap(
                "SELECT display_name, bio, phone, email::text AS email FROM auth.users WHERE id = ?", userId);
        assertThat(row.get("display_name")).isEqualTo("Новое имя");
        assertThat(row.get("bio")).isEqualTo("Люблю шифрование и котиков");
        assertThat(row.get("phone")).isEqualTo("+7 (999) 123-45-67");
        assertThat(row.get("email")).isEqualTo(idp.email());

        // Audit stores field names only; values must never enter the chain.
        String metadata = migrator().queryForObject("""
                SELECT metadata::text FROM audit.audit_events
                 WHERE action = 'profile.updated' AND actor_id = ?
                 ORDER BY created_at DESC LIMIT 1
                """, String.class, userId);
        assertThat(metadata).contains("display_name", "bio", "phone")
                .doesNotContain("Новое имя", "Люблю шифрование", "123-45-67");

        // JIT/Keycloak display-name sync is best effort but works when the IdP is up.
        assertThat(KeycloakWireMock.user(idp.email()).name()).isEqualTo("Новое имя");
    }

    @Test
    void patchValidationAndNullClearingMatchTheContract() throws Exception {
        KeycloakWireMock.TestUser idp = keycloakUser("profile-validation");
        RequestPostProcessor auth = auth(idp, null);
        UUID userId = meId(auth);

        patchBad(auth, Map.of(), 422, "VALIDATION_FAILED");
        patchBad(auth, Map.of("display_name", "   "), 400, "VALIDATION_FAILED");
        patchBad(auth, nullable("display_name", null), 400, "VALIDATION_FAILED");
        patchBad(auth, Map.of("display_name", "x".repeat(81)), 400, "VALIDATION_FAILED");
        patchBad(auth, Map.of("bio", "x".repeat(281)), 400, "VALIDATION_FAILED");
        patchBad(auth, Map.of("phone", "x".repeat(33)), 400, "VALIDATION_FAILED");

        mockMvc.perform(patch("/api/v1/me").with(auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "display_name", "Keep Me",
                                "bio", "temporary bio",
                                "phone", "+1 555 0100"))))
                .andExpect(status().isOk());

        // Explicit null (and blank bio) clear the optional fields.
        MvcResult cleared = mockMvc.perform(patch("/api/v1/me").with(auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(nullable("bio", null))))
                .andExpect(status().isOk())
                .andReturn();
        assertThat(json(cleared).get("display_name").asText()).isEqualTo("Keep Me");
        assertThat(json(cleared).get("bio").isNull()).isTrue();
        assertThat(json(cleared).get("phone").asText()).isEqualTo("+1 555 0100");

        mockMvc.perform(patch("/api/v1/me").with(auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("phone", "  "))))
                .andExpect(status().isOk());
        JsonNode me = json(mockMvc.perform(get("/api/v1/me").with(auth))
                .andExpect(status().isOk()).andReturn());
        assertThat(me.at("/user/bio").isNull()).isTrue();
        assertThat(me.at("/user/phone").isNull()).isTrue();

        // Unknown fields, including email/password, are ignored and cannot mutate identity.
        mockMvc.perform(patch("/api/v1/me").with(auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "display_name", "Still Me",
                                "email", "attacker@evil.test",
                                "password", "NewPassword123!"))))
                .andExpect(status().isOk());
        Map<String, Object> row = migrator().queryForMap(
                "SELECT display_name, email::text AS email FROM auth.users WHERE id = ?", userId);
        assertThat(row.get("display_name")).isEqualTo("Still Me");
        assertThat(row.get("email")).isEqualTo(idp.email());
    }

    @Test
    void keycloakDisplayNameSyncFailureDoesNotFailThePatch() throws Exception {
        KeycloakWireMock.TestUser idp = keycloakUser("profile-idp-down");
        RequestPostProcessor auth = auth(idp, null);
        UUID userId = meId(auth);
        KeycloakWireMock.failUserUpdates(true);

        mockMvc.perform(patch("/api/v1/me").with(auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "display_name", "Local Name"))))
                .andExpect(status().isOk());

        assertThat(migrator().queryForObject(
                "SELECT display_name FROM auth.users WHERE id = ?", String.class, userId))
                .isEqualTo("Local Name");
        assertThat(KeycloakWireMock.user(idp.email()).name()).isEqualTo("Idp Initial");
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM audit.audit_events
                 WHERE action = 'profile.updated' AND actor_id = ?
                """, Integer.class, userId)).isEqualTo(1);
    }

    @Test
    void profileUpdateDoesNotTouchE2eeDeviceKeys() throws Exception {
        KeycloakWireMock.TestUser idp = keycloakUser("profile-e2ee");
        RequestPostProcessor auth = auth(idp, null);
        UUID userId = meId(auth);
        UUID deviceId = UUID.randomUUID();
        migrator().update("""
                INSERT INTO auth.devices
                       (id, user_id, name, platform, app_version, identity_key_alg,
                        identity_signing_key, identity_dh_key,
                        identity_binding_signature, fingerprint)
                VALUES (?, ?, 'Profile Device', 'WEB', '1.0.0', 'Ed25519+X25519',
                        decode(repeat('11', 32), 'hex'), decode(repeat('22', 32), 'hex'),
                        decode(repeat('33', 64), 'hex'), decode(repeat('44', 32), 'hex'))
                """, deviceId, userId);

        mockMvc.perform(patch("/api/v1/me").with(auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "bio", "bio must not touch keys", "phone", "+44 20 0000"))))
                .andExpect(status().isOk());

        assertThat(migrator().queryForObject("""
                SELECT encode(identity_signing_key, 'hex') FROM auth.devices WHERE id = ?
                """, String.class, deviceId)).isEqualTo("11".repeat(32));
        assertThat(migrator().queryForObject(
                "SELECT status FROM auth.devices WHERE id = ?", String.class, deviceId))
                .isEqualTo("ACTIVE");
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM auth.device_prekeys WHERE device_id = ?
                """, Integer.class, deviceId)).isZero();
    }

    @Test
    void profileEndpointsRequireAuthentication() throws Exception {
        mockMvc.perform(patch("/api/v1/me")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("bio", "x"))))
                .andExpect(status().isUnauthorized());
        mockMvc.perform(get("/api/v1/me/sessions"))
                .andExpect(status().isUnauthorized());
        mockMvc.perform(delete("/api/v1/me/sessions/{sessionId}", UUID.randomUUID()))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void sessionsListIsCallerScopedOrderedAndNeverLeaksIpOrTokens() throws Exception {
        KeycloakWireMock.TestUser alice = keycloakUser("sessions-alice");
        KeycloakWireMock.TestUser bob = keycloakUser("sessions-bob");
        Instant now = Instant.parse("2026-06-01T12:00:00Z");
        String currentId = UUID.randomUUID().toString();
        String olderId = UUID.randomUUID().toString();
        String newestId = UUID.randomUUID().toString();
        KeycloakWireMock.putSession(alice.id(), olderId, "Old Browser", now.minusSeconds(3600),
                now.minusSeconds(300), "203.0.113.9");
        KeycloakWireMock.putSession(alice.id(), currentId, "Krug Web", now.minusSeconds(600),
                now.minusSeconds(60), "203.0.113.10");
        KeycloakWireMock.putSession(alice.id(), newestId, "Krug Web 2", now.minusSeconds(120),
                now, "203.0.113.11");
        KeycloakWireMock.putSession(bob.id(), UUID.randomUUID().toString(), "Bob Browser", now,
                now, "198.51.100.7");

        RequestPostProcessor auth = auth(alice, currentId);
        MvcResult result = mockMvc.perform(get("/api/v1/me/sessions").with(auth))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode body = json(result);
        CONTRACT.assertValid("ProfileSessions", body);
        assertThat(body.get("sessions")).hasSize(3);
        assertThat(body.get("sessions").get(0).get("id").asText()).isEqualTo(newestId);
        assertThat(body.get("sessions").get(1).get("id").asText()).isEqualTo(currentId);
        assertThat(body.get("sessions").get(2).get("id").asText()).isEqualTo(olderId);
        assertThat(body.at("/sessions/1/current").asBoolean()).isTrue();
        assertThat(body.at("/sessions/0/current").asBoolean()).isFalse();
        assertThat(body.at("/sessions/2/current").asBoolean()).isFalse();
        assertThat(body.at("/sessions/1/name").asText()).isEqualTo("Krug Web");
        assertThat(body.at("/sessions/0/created_at").asText()).isNotBlank();
        assertThat(body.at("/sessions/0/last_access_at").asText()).isNotBlank();

        String raw = result.getResponse().getContentAsString();
        assertThat(raw).doesNotContain("203.0.113", "198.51.100", alice.email(),
                "access_token", "refresh_token", "username", "ip_address", "ipAddress");
    }

    @Test
    void sessionRevokeIsOwnershipCheckedAndCurrentSessionIsRevocable() throws Exception {
        KeycloakWireMock.TestUser alice = keycloakUser("revoke-alice");
        KeycloakWireMock.TestUser bob = keycloakUser("revoke-bob");
        Instant now = Instant.parse("2026-06-02T09:00:00Z");
        String firstId = UUID.randomUUID().toString();
        String currentId = UUID.randomUUID().toString();
        String bobId = UUID.randomUUID().toString();
        KeycloakWireMock.putSession(alice.id(), firstId, "Krug Web", now, now, "203.0.113.1");
        KeycloakWireMock.putSession(alice.id(), currentId, "Krug Web", now, now, "203.0.113.2");
        KeycloakWireMock.putSession(bob.id(), bobId, "Bob Web", now, now, "198.51.100.1");

        RequestPostProcessor auth = auth(alice, currentId);

        mockMvc.perform(delete("/api/v1/me/sessions/{sessionId}", firstId).with(auth))
                .andExpect(status().isNoContent());
        assertThat(KeycloakWireMock.sessions(alice.id())).extracting(KeycloakWireMock.TestSession::id)
                .containsExactly(currentId);

        // Bob's session id is hidden as 404 and is not removed from Bob's list.
        MvcResult foreign = mockMvc.perform(
                        delete("/api/v1/me/sessions/{sessionId}", bobId).with(auth))
                .andExpect(status().isNotFound())
                .andReturn();
        CONTRACT.assertValid("Error", json(foreign));
        assertThat(KeycloakWireMock.sessions(bob.id())).hasSize(1);

        // Repeating the revoke of a no-longer-listed id is 404, never a side effect.
        mockMvc.perform(delete("/api/v1/me/sessions/{sessionId}", firstId).with(auth))
                .andExpect(status().isNotFound());

        // The current session is intentionally revocable (the UI can warn, the API allows).
        mockMvc.perform(delete("/api/v1/me/sessions/{sessionId}", currentId).with(auth))
                .andExpect(status().isNoContent());
        assertThat(KeycloakWireMock.sessions(alice.id())).isEmpty();

        mockMvc.perform(delete("/api/v1/me/sessions/{sessionId}", "not-a-uuid").with(auth))
                .andExpect(status().isBadRequest());
    }

    @Test
    void keycloakOutageIsA503ForListAndRevoke() throws Exception {
        KeycloakWireMock.TestUser idp = keycloakUser("sessions-down");
        String sessionId = UUID.randomUUID().toString();
        KeycloakWireMock.putSession(idp.id(), sessionId, "Krug Web", Instant.now(),
                Instant.now(), "203.0.113.50");
        RequestPostProcessor auth = auth(idp, sessionId);
        KeycloakWireMock.failAdminSessions(true);

        MvcResult list = mockMvc.perform(get("/api/v1/me/sessions").with(auth))
                .andExpect(status().isServiceUnavailable())
                .andExpect(header().exists("Retry-After"))
                .andReturn();
        JsonNode listError = json(list);
        CONTRACT.assertValid("Error", listError);
        assertThat(listError.get("code").asText()).isEqualTo("AUTH_UNAVAILABLE");
        assertThat(list.getResponse().getContentAsString()).doesNotContain(sessionId);

        MvcResult revoke = mockMvc.perform(
                        delete("/api/v1/me/sessions/{sessionId}", sessionId).with(auth))
                .andExpect(status().isServiceUnavailable())
                .andExpect(header().exists("Retry-After"))
                .andReturn();
        CONTRACT.assertValid("Error", json(revoke));
        assertThat(KeycloakWireMock.sessions(idp.id())).hasSize(1);
    }

    private KeycloakWireMock.TestUser keycloakUser(String prefix) {
        String email = KeycloakTestSupport.uniqueEmail(prefix);
        return KeycloakWireMock.putUser(email, "Idp Initial", PASSWORD, true, true);
    }

    private static RequestPostProcessor auth(KeycloakWireMock.TestUser user, String sessionId) {
        return KeycloakTestSupport.keycloakJwt(user.id().toString(), user.email(), "profile",
                "Idp Initial", sessionId);
    }

    private UUID meId(RequestPostProcessor auth) throws Exception {
        MvcResult result = mockMvc.perform(get("/api/v1/me").with(auth))
                .andExpect(status().isOk())
                .andReturn();
        CONTRACT.assertValid("MeResponse", json(result));
        return UUID.fromString(json(result).at("/user/id").asText());
    }

    private void patchBad(RequestPostProcessor auth, Map<String, Object> body, int expectedStatus,
                          String expectedCode) throws Exception {
        MvcResult result = mockMvc.perform(patch("/api/v1/me").with(auth)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andReturn();
        assertThat(result.getResponse().getStatus()).isEqualTo(expectedStatus);
        JsonNode error = json(result);
        CONTRACT.assertValid("Error", error);
        assertThat(error.get("code").asText()).isEqualTo(expectedCode);
    }

    /** JSON map that keeps an explicit null value (Map.of forbids nulls). */
    private static Map<String, Object> nullable(String key, Object value) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put(key, value);
        return body;
    }
}
