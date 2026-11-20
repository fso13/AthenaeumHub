package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.beans.factory.annotation.Autowired;
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
 * D1.1 (#76) E2EE policy: the built-in actions are server-side ({@code MANAGED}-only), so
 * polls/tasks/translate stay unavailable even if a toggle row is injected directly. No
 * ciphertext is read, no poll/task is created and no audit event is written.
 */
@org.springframework.boot.test.context.SpringBootTest(properties = "krug.e2ee.enabled=true")
@ActiveProfiles("test")
class E2eePluginActionsIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Autowired
    private TokenIssuer tokenIssuer;

    @Test
    void serverPluginActionsStayUnavailableInE2ee() throws Exception {
        SessionResponse alice = devSession(uniqueDisplayName("actions-e2ee-alice"));
        SessionResponse bob = devSession(uniqueDisplayName("actions-e2ee-bob"));
        UUID workspaceId = createE2eeWorkspace(alice);
        joinWorkspace(workspaceId, bob.user().id());
        UUID chatId = seedE2eeDirect(workspaceId, alice, bob);
        SessionResponse aliceInChat = scoped(alice, workspaceId);

        // Bypass the API to prove the action gate fails closed even with a stored toggle.
        for (String pluginId : new String[]{"polls", "tasks", "translate"}) {
            migrator().update("""
                    INSERT INTO chat.chat_plugins
                           (workspace_id, chat_id, plugin_id, enabled, updated_by)
                    VALUES (?, ?, ?, true, ?)
                    ON CONFLICT (chat_id, plugin_id) DO UPDATE SET enabled = true
                    """, workspaceId, chatId, pluginId, alice.user().id());
        }

        assertUnavailable(mockMvc.perform(authed(
                get("/api/v1/chats/{chatId}/polls", chatId), aliceInChat)));
        assertUnavailable(mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/polls", chatId), aliceInChat)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of(
                        "question", "E2EE?", "options", java.util.List.of("a", "b"))))));
        assertUnavailable(mockMvc.perform(authed(
                get("/api/v1/chats/{chatId}/tasks", chatId), aliceInChat)));
        assertUnavailable(mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/tasks", chatId), aliceInChat)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("title", "E2EE task")))));
        assertUnavailable(mockMvc.perform(authed(
                        patch("/api/v1/chats/{chatId}/tasks/{taskId}", chatId,
                                UUID.randomUUID()), aliceInChat)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("done", true)))));
        assertUnavailable(mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/messages/{messageId}/translate", chatId,
                                UUID.randomUUID()), aliceInChat)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("target", "ru")))));

        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM plugin.polls WHERE chat_id = ?", Long.class, chatId))
                .isZero();
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM plugin.tasks WHERE chat_id = ?", Long.class, chatId))
                .isZero();
        // #95: no poll/task entity means no POLL/TASK timeline message either; nothing
        // plaintext or ciphertext is written for a rejected E2EE plugin action.
        assertThat(messageCount(chatId)).isZero();
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM audit.audit_events
                 WHERE actor_id = ?
                   AND (action LIKE 'chat.poll.%' OR action LIKE 'chat.task.%'
                        OR action = 'chat.message.translated')
                """, Long.class, alice.user().id())).isZero();
    }

    // ------------------------------------------------------------------

    private SessionResponse scoped(SessionResponse user, UUID workspaceId) {
        IssuedToken token = tokenIssuer.issue(user.user().id(), user.device().id(), workspaceId);
        return new SessionResponse(token.accessToken(), token.expiresAt(), user.user(),
                user.device(), user.workspace(), user.chat());
    }

    private UUID createE2eeWorkspace(SessionResponse owner) throws Exception {
        MvcResult result = mockMvc.perform(authed(post("/api/v1/workspaces"), owner)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name", "e2ee-actions-" + UUID.randomUUID(),
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

    private UUID seedE2eeDirect(UUID workspaceId, SessionResponse alice, SessionResponse bob) {
        UUID chatId = UUID.randomUUID();
        migrator().update("""
                INSERT INTO chat.chats
                       (id, workspace_id, type, security_mode, name, created_by, direct_key)
                VALUES (?, ?, 'DIRECT', 'E2EE', 'e2ee-actions', ?, ?)
                """, chatId, workspaceId, alice.user().id(),
                DirectPairKey.of(alice.user().id(), bob.user().id()));
        migrator().update("""
                INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
                VALUES (?, ?, ?, 'OWNER', 'ACTIVE'), (?, ?, ?, 'MEMBER', 'ACTIVE')
                """, chatId, workspaceId, alice.user().id(),
                chatId, workspaceId, bob.user().id());
        return chatId;
    }

    private void assertUnavailable(ResultActions actions) throws Exception {
        MvcResult result = actions.andExpect(status().isUnprocessableEntity()).andReturn();
        JsonNode body = json(result);
        CONTRACT.assertValid("Error", body);
        assertThat(body.get("code").asText()).isEqualTo("PLUGIN_NOT_AVAILABLE");
    }
}
