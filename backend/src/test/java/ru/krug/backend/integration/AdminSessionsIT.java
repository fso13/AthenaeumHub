package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.Instant;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.KeycloakTestSupport;
import ru.krug.backend.support.KeycloakWireMock;
import ru.krug.backend.support.OpenApiContract;

/**
 * #84: platform-admin session listing/revocation against the real Keycloak Admin adapter
 * (WireMock fake). Covers the subject lookup, current-session flag, cursor binding, the
 * platform-admin gate, 404 for a user without an identity, idempotent revoke and the 503
 * outage path.
 */
@SpringBootTest(properties = {
        "krug.files.scan-enabled=false",
        "krug.files.gc-enabled=false",
        "krug.files.reconcile-enabled=false",
        "krug.content.key=admin-sessions-test-content-key-32",
        "krug.auth-bff.keycloak.admin-password=admin-sessions-test",
        "krug.auth-bff.cleanup.enabled=false"
})
@ActiveProfiles("keycloak")
class AdminSessionsIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();
    private static final String ADMIN_SID = UUID.randomUUID().toString();
    private static final String TARGET_ONE = UUID.randomUUID().toString();
    private static final String TARGET_TWO = UUID.randomUUID().toString();

    @DynamicPropertySource
    static void keycloak(DynamicPropertyRegistry registry) {
        registry.add("krug.auth-bff.keycloak.base-url", KeycloakWireMock::baseUrl);
        registry.add("krug.oidc.issuer", KeycloakWireMock::issuer);
        registry.add("krug.oidc.jwk-set-uri", KeycloakWireMock::jwksUri);
    }

    @BeforeEach
    void resetFakeIdp() {
        KeycloakWireMock.reset();
        migrator().update("DELETE FROM audit.audit_events WHERE action IN "
                + "('admin.sessions.viewed','admin.session.revoked',"
                + "'admin.sessions.revoked_all')");
    }

    @Test
    void listsSessionsForSelectedUserWithCursorAndNoPii() throws Exception {
        Actor admin = provision("admin-sessions", ADMIN_SID);
        Actor target = provision("admin-target", null);
        promote(admin.localId());
        Instant now = Instant.parse("2026-11-20T10:00:00Z");
        KeycloakWireMock.putSession(target.idp.id(), TARGET_ONE, "Target Web",
                now.minusSeconds(600), now.minusSeconds(60), "203.0.113.10");
        KeycloakWireMock.putSession(target.idp.id(), TARGET_TWO, "Target Phone",
                now.minusSeconds(1200), now.minusSeconds(300), "198.51.100.7");
        KeycloakWireMock.putSession(admin.idp.id(), ADMIN_SID, "Admin Web",
                now.minusSeconds(300), now.minusSeconds(10), "192.0.2.5");

        MvcResult result = mockMvc.perform(authed(
                        get("/api/v1/admin/sessions").param("user_id",
                                target.localId().toString()), admin.auth()))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode body = json(result);
        CONTRACT.assertValid("AdminSessionPage", body);
        assertThat(body.get("items").size()).isEqualTo(2);
        assertThat(body.at("/items/0/id").asText()).isEqualTo(TARGET_ONE);
        assertThat(body.at("/items/1/id").asText()).isEqualTo(TARGET_TWO);
        for (JsonNode item : body.get("items")) {
            assertThat(item.get("user_id").asText())
                    .isEqualTo(target.localId().toString());
            assertThat(item.get("current").asBoolean()).isFalse();
        }
        assertThat(result.getResponse().getContentAsString())
                .doesNotContain("203.0.113", "198.51.100", "192.0.2", target.idp.email(),
                        "access_token", "refresh_token", "ipAddress", "username");

        MvcResult own = mockMvc.perform(authed(
                        get("/api/v1/admin/sessions").param("user_id",
                                admin.localId().toString()), admin.auth()))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode ownBody = json(own);
        CONTRACT.assertValid("AdminSessionPage", ownBody);
        assertThat(ownBody.get("items").size()).isEqualTo(1);
        assertThat(ownBody.at("/items/0/id").asText()).isEqualTo(ADMIN_SID);
        assertThat(ownBody.at("/items/0/current").asBoolean()).isTrue();

        JsonNode first = json(mockMvc.perform(authed(
                        get("/api/v1/admin/sessions")
                                .param("user_id", target.localId().toString())
                                .param("limit", "1"), admin.auth()))
                .andExpect(status().isOk()).andReturn());
        assertThat(first.get("has_more").asBoolean()).isTrue();
        String cursor = first.get("next_cursor").asText();
        JsonNode second = json(mockMvc.perform(authed(
                        get("/api/v1/admin/sessions")
                                .param("user_id", target.localId().toString())
                                .param("cursor", cursor), admin.auth()))
                .andExpect(status().isOk()).andReturn());
        assertThat(second.get("items").size()).isEqualTo(1);
        assertThat(second.at("/items/0/id").asText()).isNotEqualTo(TARGET_ONE);

        mockMvc.perform(authed(get("/api/v1/admin/sessions")
                        .param("user_id", admin.localId().toString())
                        .param("cursor", cursor), admin.auth()))
                .andExpect(status().isBadRequest());
        mockMvc.perform(authed(get("/api/v1/admin/sessions")
                        .param("user_id", target.localId().toString())
                        .param("limit", "0"), admin.auth()))
                .andExpect(status().isBadRequest());
        mockMvc.perform(authed(get("/api/v1/admin/sessions")
                        .param("user_id", UUID.randomUUID().toString()), admin.auth()))
                .andExpect(status().isNotFound());
        mockMvc.perform(authed(get("/api/v1/admin/sessions")
                        .param("user_id", target.localId().toString()), target.auth()))
                .andExpect(status().isForbidden());
    }

    @Test
    void revokesOneSessionByIdempotentIdAndAllUserSessions() throws Exception {
        Actor admin = provision("admin-revoke", ADMIN_SID);
        Actor target = provision("admin-revoke-target", null);
        promote(admin.localId());
        Instant now = Instant.parse("2026-11-20T10:00:00Z");
        KeycloakWireMock.putSession(target.idp.id(), TARGET_ONE, "Target Web", now, now,
                "203.0.113.1");
        KeycloakWireMock.putSession(target.idp.id(), TARGET_TWO, "Target Phone", now, now,
                "203.0.113.2");

        mockMvc.perform(authed(delete("/api/v1/admin/sessions/{id}", TARGET_ONE),
                        admin.auth()))
                .andExpect(status().isNoContent());
        assertThat(KeycloakWireMock.sessions(target.idp.id()))
                .extracting(KeycloakWireMock.TestSession::id)
                .containsExactly(TARGET_TWO);
        mockMvc.perform(authed(delete("/api/v1/admin/sessions/{id}", TARGET_ONE),
                        admin.auth()))
                .andExpect(status().isNoContent());

        MvcResult revokeAll = mockMvc.perform(authed(
                        post("/api/v1/admin/users/{id}/revoke-sessions", target.localId()),
                        admin.auth()))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode body = json(revokeAll);
        CONTRACT.assertValid("AdminSessionRevokeAll", body);
        assertThat(body.get("revoked_sessions").asInt()).isEqualTo(1);
        assertThat(body.get("affected_users").asInt()).isEqualTo(1);
        assertThat(KeycloakWireMock.sessions(target.idp.id())).isEmpty();

        mockMvc.perform(authed(post("/api/v1/admin/users/{id}/revoke-sessions",
                        UUID.randomUUID()), admin.auth()))
                .andExpect(status().isNotFound());
        mockMvc.perform(authed(post("/api/v1/admin/users/{id}/revoke-sessions",
                        target.localId()), target.auth()))
                .andExpect(status().isForbidden());

        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM audit.audit_events
                 WHERE action IN ('admin.session.revoked', 'admin.sessions.revoked_all')
                """, Integer.class)).isGreaterThanOrEqualTo(2);
    }

    @Test
    void keycloakOutageIsServiceUnavailableForAllSessionOperations() throws Exception {
        Actor admin = provision("admin-outage", ADMIN_SID);
        Actor target = provision("admin-outage-target", null);
        promote(admin.localId());
        Instant now = Instant.parse("2026-11-20T10:00:00Z");
        KeycloakWireMock.putSession(target.idp.id(), TARGET_ONE, "Target Web", now, now,
                "203.0.113.1");
        KeycloakWireMock.failAdminSessions(true);

        MvcResult list = mockMvc.perform(authed(get("/api/v1/admin/sessions")
                        .param("user_id", target.localId().toString()), admin.auth()))
                .andExpect(status().isServiceUnavailable())
                .andExpect(header().exists("Retry-After"))
                .andReturn();
        assertThat(json(list).get("code").asText()).isEqualTo("AUTH_UNAVAILABLE");
        mockMvc.perform(authed(delete("/api/v1/admin/sessions/{id}", TARGET_ONE),
                        admin.auth()))
                .andExpect(status().isServiceUnavailable());
        mockMvc.perform(authed(post("/api/v1/admin/users/{id}/revoke-sessions",
                        target.localId()), admin.auth()))
                .andExpect(status().isServiceUnavailable());
        assertThat(KeycloakWireMock.sessions(target.idp.id())).hasSize(1);
    }

    private Actor provision(String prefix, String sessionId) throws Exception {
        String email = KeycloakTestSupport.uniqueEmail(prefix);
        KeycloakWireMock.TestUser idp = KeycloakWireMock.putUser(email, prefix,
                "VeryStrongPass123!", true, true);
        RequestPostProcessor auth = KeycloakTestSupport.keycloakJwt(idp.id().toString(), email,
                "krug", "Test User", sessionId);
        UUID localId = UUID.fromString(json(mockMvc.perform(get("/api/v1/me").with(auth))
                .andExpect(status().isOk()).andReturn()).at("/user/id").asText());
        return new Actor(idp, auth, localId);
    }

    private void promote(UUID userId) {
        migrator().update("UPDATE auth.users SET is_platform_admin = false "
                + "WHERE is_platform_admin");
        migrator().update("UPDATE auth.users SET is_platform_admin = true WHERE id = ?",
                userId);
    }

    private MockHttpServletRequestBuilder authed(MockHttpServletRequestBuilder builder,
                                                 RequestPostProcessor auth) {
        return builder.with(auth);
    }

    private record Actor(KeycloakWireMock.TestUser idp, RequestPostProcessor auth,
                         UUID localId) {
    }
}
