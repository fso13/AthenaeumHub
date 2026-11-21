package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.ResultActions;

import ru.krug.backend.chat.domain.service.DirectPairKey;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.shared.application.model.IssuedToken;
import ru.krug.backend.shared.application.port.TokenIssuer;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

/**
 * D1.1 (#69) E2EE policy: the built-in catalog is server-side ({@code MANAGED}-only), so
 * every plugin is unavailable in an E2EE chat and can never be enabled. Rejection is
 * atomic: no toggle row and no audit event.
 */
@org.springframework.boot.test.context.SpringBootTest(properties = "krug.e2ee.enabled=true")
@ActiveProfiles("test")
class E2eePluginsIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Autowired
    private TokenIssuer tokenIssuer;

    @Test
    void serverPluginsAreUnavailableAndCannotBeToggledInE2ee() throws Exception {
        SessionResponse alice = devSession(uniqueDisplayName("plugins-e2ee-alice"));
        SessionResponse bob = devSession(uniqueDisplayName("plugins-e2ee-bob"));
        UUID workspaceId = createE2eeWorkspace(alice);
        joinWorkspace(workspaceId, bob.user().id());
        UUID chatId = seedE2eeDirect(workspaceId, alice, bob);
        SessionResponse aliceInChat = scoped(alice, workspaceId);
        SessionResponse bobInChat = scoped(bob, workspaceId);

        // The global catalog is readable in E2EE; its modes still say MANAGED only.
        MvcResult catalog = mockMvc.perform(authed(get("/api/v1/plugins"), alice))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode catalogBody = json(catalog);
        CONTRACT.assertValid("PluginList", catalogBody);
        assertThat(catalogBody.get("items")).hasSize(6);
        for (JsonNode item : catalogBody.get("items")) {
            CONTRACT.assertValid("Plugin", item);
            assertThat(item.get("modes")).hasSize(1);
            assertThat(item.get("modes").get(0).asText()).isEqualTo("MANAGED");
        }

        MvcResult states = mockMvc.perform(authed(
                        get("/api/v1/chats/{chatId}/plugins", chatId), aliceInChat))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode stateBody = json(states);
        CONTRACT.assertValid("ChatPluginStateList", stateBody);
        assertThat(stateBody.get("items")).hasSize(6);
        for (JsonNode item : stateBody.get("items")) {
            CONTRACT.assertValid("ChatPluginState", item);
            assertThat(item.get("enabled").asBoolean()).isFalse();
            assertThat(item.get("available").asBoolean()).isFalse();
            assertThat(item.get("reason").asText()).isEqualTo("PLUGIN_NOT_AVAILABLE");
        }

        assertUnavailable(patchPlugin(aliceInChat, chatId, "polls", true));
        assertUnavailable(patchPlugin(aliceInChat, chatId, "polls", false));
        assertThat(toggleCount(chatId)).isZero();
        assertThat(auditCount(chatId)).isZero();

        // The stored state never appears: a subsequent read is still default-off.
        assertThat(state(json(mockMvc.perform(authed(
                        get("/api/v1/chats/{chatId}/plugins", chatId), aliceInChat))
                .andExpect(status().isOk()).andReturn()), "polls").get("enabled").asBoolean())
                .isFalse();

        // Unknown plugin in E2EE is a 404 (existence is checked before availability).
        MvcResult unknown = patchPlugin(aliceInChat, chatId, "does-not-exist", true)
                .andExpect(status().isNotFound()).andReturn();
        CONTRACT.assertValid("Error", json(unknown));
        assertThat(json(unknown).get("code").asText()).isEqualTo("PLUGIN_NOT_FOUND");

        // A plain MEMBER cannot toggle even if a plugin were available.
        assertForbidden(patchPlugin(bobInChat, chatId, "polls", true));
        assertThat(toggleCount(chatId)).isZero();
        assertThat(auditCount(chatId)).isZero();
    }

    // ------------------------------------------------------------------

    private UUID createE2eeWorkspace(SessionResponse owner) throws Exception {
        MvcResult result = mockMvc.perform(authed(post("/api/v1/workspaces"), owner)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name", "e2ee-plugins-" + UUID.randomUUID(),
                                "security_mode", "E2EE"))))
                .andExpect(status().isCreated())
                .andReturn();
        return UUID.fromString(json(result).get("id").asText());
    }

    private void joinWorkspace(UUID workspaceId, UUID userId) {
        migrator().update("""
                INSERT INTO workspace.memberships (workspace_id, user_id, role, status)
                VALUES (?, ?, 'MEMBER', 'ACTIVE')
                ON CONFLICT (workspace_id, user_id) DO UPDATE SET status = 'ACTIVE'
                """, workspaceId, userId);
    }

    /**
     * Seeds a valid E2EE DIRECT row (two members, ordered direct_key) without going through
     * the device-capability creation gate; the plugin slice only needs an existing chat.
     */
    private UUID seedE2eeDirect(UUID workspaceId, SessionResponse alice, SessionResponse bob) {
        UUID chatId = UUID.randomUUID();
        migrator().update("""
                INSERT INTO chat.chats
                       (id, workspace_id, type, security_mode, name, created_by, direct_key)
                VALUES (?, ?, 'DIRECT', 'E2EE', 'e2ee-plugins', ?, ?)
                """, chatId, workspaceId, alice.user().id(),
                DirectPairKey.of(alice.user().id(), bob.user().id()));
        migrator().update("""
                INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
                VALUES (?, ?, ?, 'OWNER', 'ACTIVE'), (?, ?, ?, 'MEMBER', 'ACTIVE')
                """, chatId, workspaceId, alice.user().id(),
                chatId, workspaceId, bob.user().id());
        migrator().update("""
                INSERT INTO chat.chat_counters (chat_id, workspace_id, next_seq)
                VALUES (?, ?, 1)
                """, chatId, workspaceId);
        return chatId;
    }

    private SessionResponse scoped(SessionResponse user, UUID workspaceId) {
        IssuedToken token = tokenIssuer.issue(user.user().id(), user.device().id(), workspaceId);
        return new SessionResponse(token.accessToken(), token.expiresAt(), user.user(),
                user.device(), user.workspace(), user.chat());
    }

    private ResultActions patchPlugin(SessionResponse actor, UUID chatId, String pluginId,
                                      boolean enabled) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("enabled", enabled);
        return mockMvc.perform(authed(
                        patch("/api/v1/chats/{chatId}/plugins/{pluginId}", chatId, pluginId),
                        actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body)));
    }

    private void assertUnavailable(ResultActions actions) throws Exception {
        MvcResult result = actions.andExpect(status().isUnprocessableEntity()).andReturn();
        JsonNode body = json(result);
        CONTRACT.assertValid("Error", body);
        assertThat(body.get("code").asText()).isEqualTo("PLUGIN_NOT_AVAILABLE");
        assertThat(body.get("details").get("reason").asText())
                .isEqualTo("PLUGIN_NOT_AVAILABLE");
    }

    private void assertForbidden(ResultActions actions) throws Exception {
        MvcResult result = actions.andExpect(status().isForbidden()).andReturn();
        JsonNode body = json(result);
        CONTRACT.assertValid("Error", body);
        assertThat(body.get("code").asText()).isEqualTo("FORBIDDEN");
    }

    private JsonNode state(JsonNode states, String pluginId) {
        for (JsonNode item : states.get("items")) {
            if (pluginId.equals(item.get("plugin_id").asText())) {
                return item;
            }
        }
        throw new AssertionError("state not found: " + pluginId);
    }

    private long toggleCount(UUID chatId) {
        Long count = migrator().queryForObject(
                "SELECT count(*) FROM chat.chat_plugins WHERE chat_id = ?", Long.class, chatId);
        return count == null ? 0 : count;
    }

    private long auditCount(UUID chatId) {
        Long count = migrator().queryForObject("""
                SELECT count(*) FROM audit.audit_events
                 WHERE action = 'chat.plugin.changed' AND target_id = ?
                """, Long.class, chatId);
        return count == null ? 0 : count;
    }
}
