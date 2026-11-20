package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.Instant;
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
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.request.RequestPostProcessor;

import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.KeycloakTestSupport;
import ru.krug.backend.support.KeycloakWireMock;
import ru.krug.backend.support.OpenApiContract;

/**
 * P0-3 (#81): workspace member session list/revoke/revoke-all against the real Keycloak
 * Admin adapter (WireMock fake), including current-session detection, foreign ownership,
 * the manager gate and the 503 outage path.
 */
@SpringBootTest(properties = {
        "krug.files.scan-enabled=false",
        "krug.files.gc-enabled=false",
        "krug.files.reconcile-enabled=false",
        "krug.content.key=workspace-sessions-test-content-key-32",
        "krug.auth-bff.keycloak.admin-password=sessions-test-admin",
        "krug.auth-bff.cleanup.enabled=false"
})
@ActiveProfiles("keycloak")
class WorkspaceSessionsIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();
    private static final String PASSWORD = "VeryStrongPass123!";
    private static final String CURRENT_ID = UUID.randomUUID().toString();
    private static final String OLD_ID = UUID.randomUUID().toString();
    private static final String MEMBER_ID = UUID.randomUUID().toString();
    private static final String OUTSIDER_ID = UUID.randomUUID().toString();

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
    void listsSessionsAcrossMembersWithCurrentAndNoPii() throws Exception {
        Actor owner = provision("sessions-owner", CURRENT_ID);
        Actor member = provision("sessions-member", null);
        Actor outsider = provision("sessions-outsider", null);
        addMember(owner, member, "MEMBER");

        Instant now = Instant.parse("2026-11-20T10:00:00Z");
        KeycloakWireMock.putSession(owner.idp.id(), CURRENT_ID, "Krug Web",
                now.minusSeconds(600), now.minusSeconds(60), "203.0.113.10");
        KeycloakWireMock.putSession(owner.idp.id(), OLD_ID, "Old Browser",
                now.minusSeconds(3600), now.minusSeconds(300), "203.0.113.11");
        KeycloakWireMock.putSession(member.idp.id(), MEMBER_ID, "Member Web",
                now.minusSeconds(300), now.minusSeconds(10), "198.51.100.7");
        KeycloakWireMock.putSession(outsider.idp.id(), OUTSIDER_ID, "Outsider Web",
                now, now, "192.0.2.5");

        MvcResult result = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/sessions", owner.workspaceId())
                                .header("X-Device-Id", owner.deviceId()), owner.auth()))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode body = json(result);
        CONTRACT.assertValid("WorkspaceSessionPage", body);
        assertThat(body.get("items")).hasSize(3);
        assertThat(body.get("has_more").asBoolean()).isFalse();
        assertThat(body.get("items")).extracting(node -> node.get("id").asText())
                .containsExactly(MEMBER_ID, CURRENT_ID, OLD_ID);

        boolean sawCurrent = false;
        for (JsonNode item : body.get("items")) {
            String id = item.get("id").asText();
            if (CURRENT_ID.equals(id)) {
                sawCurrent = true;
                assertThat(item.get("current").asBoolean()).isTrue();
                assertThat(item.get("user_id").asText())
                        .isEqualTo(owner.localId().toString());
            } else {
                assertThat(item.get("current").asBoolean()).isFalse();
            }
            if (MEMBER_ID.equals(id)) {
                assertThat(item.get("user_id").asText())
                        .isEqualTo(member.localId().toString());
                assertThat(item.get("device").asText()).isEqualTo("Member Web");
            }
        }
        assertThat(sawCurrent).isTrue();
        assertThat(result.getResponse().getContentAsString())
                .doesNotContain("203.0.113", "198.51.100", "192.0.2", owner.idp.email(),
                        "access_token", "refresh_token", "username", "ipAddress",
                        "ip_address", OUTSIDER_ID);

        MvcResult first = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/sessions", owner.workspaceId())
                                .param("limit", "2").header("X-Device-Id", owner.deviceId()),
                        owner.auth()))
                .andExpect(status().isOk())
                .andReturn();
        assertThat(json(first).get("items")).hasSize(2);
        assertThat(json(first).get("has_more").asBoolean()).isTrue();
        String cursor = json(first).get("next_cursor").asText();
        MvcResult second = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/sessions", owner.workspaceId())
                                .param("limit", "2").param("cursor", cursor)
                                .header("X-Device-Id", owner.deviceId()), owner.auth()))
                .andExpect(status().isOk())
                .andReturn();
        assertThat(json(second).get("items")).hasSize(1);
        assertThat(json(second).get("has_more").asBoolean()).isFalse();
    }

    @Test
    void revokesMemberSessionAndHidesForeignOrNonManager() throws Exception {
        Actor owner = provision("revoke-owner", CURRENT_ID);
        Actor member = provision("revoke-member", null);
        Actor outsider = provision("revoke-outsider", null);
        addMember(owner, member, "MEMBER");
        Instant now = Instant.parse("2026-11-20T10:05:00Z");
        KeycloakWireMock.putSession(owner.idp.id(), CURRENT_ID, "Krug Web", now, now, "203.0.113.1");
        KeycloakWireMock.putSession(member.idp.id(), MEMBER_ID, "Member Web", now, now,
                "203.0.113.2");
        KeycloakWireMock.putSession(outsider.idp.id(), OUTSIDER_ID, "Outsider Web", now, now,
                "203.0.113.3");

        mockMvc.perform(authed(delete("/api/v1/workspaces/{id}/sessions/{sessionId}",
                                owner.workspaceId(), MEMBER_ID)
                        .header("X-Device-Id", owner.deviceId()), owner.auth()))
                .andExpect(status().isNoContent());
        assertThat(KeycloakWireMock.sessions(member.idp.id())).isEmpty();

        // A session id outside the workspace is 404 and keeps the outsider session.
        MvcResult foreign = mockMvc.perform(authed(
                        delete("/api/v1/workspaces/{id}/sessions/{sessionId}",
                                owner.workspaceId(), OUTSIDER_ID)
                                .header("X-Device-Id", owner.deviceId()), owner.auth()))
                .andExpect(status().isNotFound())
                .andReturn();
        CONTRACT.assertValid("Error", json(foreign));
        assertThat(KeycloakWireMock.sessions(outsider.idp.id())).hasSize(1);

        // A plain MEMBER cannot revoke at all.
        mockMvc.perform(authed(delete("/api/v1/workspaces/{id}/sessions/{sessionId}",
                                owner.workspaceId(), CURRENT_ID)
                        .header("X-Device-Id", member.deviceId()), member.auth()))
                .andExpect(status().isForbidden());
        mockMvc.perform(authed(get("/api/v1/workspaces/{id}/sessions", owner.workspaceId())
                        .header("X-Device-Id", member.deviceId()), member.auth()))
                .andExpect(status().isForbidden());
        assertThat(KeycloakWireMock.sessions(owner.idp.id())).hasSize(1);

        mockMvc.perform(authed(delete("/api/v1/workspaces/{id}/sessions/{sessionId}",
                                owner.workspaceId(), UUID.randomUUID())
                        .header("X-Device-Id", owner.deviceId()), owner.auth()))
                .andExpect(status().isNotFound());
    }

    @Test
    void revokeAllKeepsCallerCurrentAndHandlesOutage() throws Exception {
        Actor owner = provision("revoke-all-owner", CURRENT_ID);
        Actor member = provision("revoke-all-member", null);
        addMember(owner, member, "MEMBER");
        Instant now = Instant.parse("2026-11-20T10:10:00Z");
        KeycloakWireMock.putSession(owner.idp.id(), CURRENT_ID, "Krug Web", now, now, "203.0.113.1");
        KeycloakWireMock.putSession(owner.idp.id(), OLD_ID, "Old Browser", now, now,
                "203.0.113.2");
        KeycloakWireMock.putSession(member.idp.id(), MEMBER_ID, "Member Web", now, now,
                "203.0.113.3");

        MvcResult result = mockMvc.perform(authed(
                        post("/api/v1/workspaces/{id}/sessions/revoke-all", owner.workspaceId())
                                .header("X-Device-Id", owner.deviceId()), owner.auth()))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode body = json(result);
        CONTRACT.assertValid("WorkspaceSessionRevokeAll", body);
        assertThat(body.get("revoked_sessions").asInt()).isEqualTo(2);
        assertThat(body.get("affected_users").asInt()).isEqualTo(2);
        assertThat(KeycloakWireMock.sessions(owner.idp.id()))
                .extracting(KeycloakWireMock.TestSession::id)
                .containsExactly(CURRENT_ID);
        assertThat(KeycloakWireMock.sessions(member.idp.id())).isEmpty();

        // Outage: list, single revoke and revoke-all all answer 503 without removing rows.
        KeycloakWireMock.putSession(owner.idp.id(), OLD_ID, "Old Browser", now, now,
                "203.0.113.2");
        KeycloakWireMock.failAdminSessions(true);
        MvcResult list = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/sessions", owner.workspaceId())
                                .header("X-Device-Id", owner.deviceId()), owner.auth()))
                .andExpect(status().isServiceUnavailable())
                .andExpect(header().exists("Retry-After"))
                .andReturn();
        assertThat(json(list).get("code").asText()).isEqualTo("AUTH_UNAVAILABLE");
        mockMvc.perform(authed(delete("/api/v1/workspaces/{id}/sessions/{sessionId}",
                                owner.workspaceId(), OLD_ID)
                        .header("X-Device-Id", owner.deviceId()), owner.auth()))
                .andExpect(status().isServiceUnavailable());
        mockMvc.perform(authed(
                        post("/api/v1/workspaces/{id}/sessions/revoke-all", owner.workspaceId())
                                .header("X-Device-Id", owner.deviceId()), owner.auth()))
                .andExpect(status().isServiceUnavailable());
        assertThat(KeycloakWireMock.sessions(owner.idp.id())).hasSize(2);
    }

    private MockHttpServletRequestBuilder authed(MockHttpServletRequestBuilder builder,
                                                 RequestPostProcessor auth) {
        return builder.with(auth);
    }

    private Actor provision(String prefix, String sessionId) throws Exception {
        String email = KeycloakTestSupport.uniqueEmail(prefix);
        KeycloakWireMock.TestUser idp = KeycloakWireMock.putUser(email, prefix, PASSWORD, true,
                true);
        RequestPostProcessor auth = auth(idp, sessionId);
        UUID localId = meId(auth);
        String deviceId = registerDevice(auth, prefix + " Chrome");
        UUID workspaceId = createWorkspace(auth, deviceId);
        return new Actor(idp, auth, localId, deviceId, workspaceId);
    }

    private RequestPostProcessor auth(KeycloakWireMock.TestUser user, String sessionId) {
        return KeycloakTestSupport.keycloakJwt(user.id().toString(), user.email(), "krug",
                "Test User", sessionId);
    }

    private UUID meId(RequestPostProcessor auth) throws Exception {
        MvcResult result = mockMvc.perform(get("/api/v1/me").with(auth))
                .andExpect(status().isOk())
                .andReturn();
        CONTRACT.assertValid("MeResponse", json(result));
        return UUID.fromString(json(result).at("/user/id").asText());
    }

    private String registerDevice(RequestPostProcessor auth, String name) throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/devices").with(auth)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name", name, "platform", "WEB", "app_version", "1.0.0"))))
                .andExpect(status().isCreated())
                .andReturn();
        return json(result).get("id").asText();
    }

    private UUID createWorkspace(RequestPostProcessor auth, String deviceId) throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/workspaces").with(auth)
                        .header("X-Device-Id", deviceId)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name", "Sessions Workspace " + UUID.randomUUID(),
                                "security_mode", "MANAGED"))))
                .andExpect(status().isCreated())
                .andReturn();
        return UUID.fromString(json(result).get("id").asText());
    }

    private void addMember(Actor owner, Actor member, String role) throws Exception {
        mockMvc.perform(post("/api/v1/workspaces/{id}/members", owner.workspaceId())
                        .with(owner.auth())
                        .header("X-Device-Id", owner.deviceId())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "email", member.idp.email(), "role", role))))
                .andExpect(status().isCreated());
    }

    private record Actor(KeycloakWireMock.TestUser idp, RequestPostProcessor auth,
                         UUID localId, String deviceId, UUID workspaceId) {
    }
}
