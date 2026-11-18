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
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.chat.domain.service.DirectPairKey;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;
import ru.krug.backend.support.OpenApiContract;

/**
 * D1-BE3 E2EE policy: a chat description is product content and remains unsupported for
 * E2EE, while the chat name label stays editable. Rejection is atomic — a combined
 * name+description patch changes nothing.
 */
@org.springframework.boot.test.context.SpringBootTest(properties = "krug.e2ee.enabled=true")
@ActiveProfiles("test")
class E2eeChatSettingsIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Test
    void e2eeAllowsNameButRejectsDescriptionAtomically() throws Exception {
        SessionResponse alice = devSession(uniqueDisplayName("d1be3-e2ee-alice"));
        SessionResponse bob = devSession(uniqueDisplayName("d1be3-e2ee-bob"));
        UUID workspaceId = createE2eeWorkspace(alice);
        joinWorkspace(workspaceId, bob.user().id());
        UUID chatId = seedE2eeDirect(workspaceId, alice, bob);

        assertE2eeUnsupported(patchChat(alice, chatId, Map.of("description", "secret")));
        assertE2eeUnsupported(patchChat(alice, chatId, Map.of("description", "")));
        assertE2eeUnsupported(patchChat(alice, chatId, Map.of(
                "name", "should-not-apply", "description", "secret")));

        Map<String, Object> row = migrator().queryForMap(
                "SELECT name, description FROM chat.chats WHERE id = ?", chatId);
        assertThat(row.get("name")).isEqualTo("e2ee-chat");
        assertThat(row.get("description")).isNull();
        assertThat(auditCount(chatId)).isZero();

        MvcResult renamed = patchChat(alice, chatId, Map.of("name", "  E2EE   label  "))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode body = json(renamed);
        CONTRACT.assertValid("Chat", body);
        assertThat(body.get("security_mode").asText()).isEqualTo("E2EE");
        assertThat(body.get("name").asText()).isEqualTo("E2EE label");
        assertThat(body.get("description").isNull()).isTrue();

        Map<String, Object> event = migrator().queryForMap("""
                SELECT actor_id, target_type, metadata::text AS metadata
                  FROM audit.audit_events
                 WHERE action = 'chat.updated' AND target_id = ?
                 ORDER BY created_at DESC, id DESC
                 LIMIT 1
                """, chatId);
        assertThat(event.get("actor_id")).isEqualTo(alice.user().id());
        assertThat(event.get("target_type")).isEqualTo("chat");
        String metadata = String.valueOf(event.get("metadata"));
        assertThat(metadata).contains("\"fields\"").contains("name")
                .doesNotContain("description").doesNotContain("E2EE label");

        MvcResult list = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{workspaceId}/chats", workspaceId), alice))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode item = json(list).get("items").get(0);
        CONTRACT.assertValid("ChatSummary", item);
        assertThat(item.get("name").asText()).isEqualTo("E2EE label");
        assertThat(item.get("description").isNull()).isTrue();
    }

    // ------------------------------------------------------------------

    private UUID createE2eeWorkspace(SessionResponse owner) throws Exception {
        MvcResult result = mockMvc.perform(authed(post("/api/v1/workspaces"), owner)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name", "e2ee-settings-" + UUID.randomUUID(),
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
     * the device-capability creation gate; D1-BE3 only needs an existing E2EE chat.
     */
    private UUID seedE2eeDirect(UUID workspaceId, SessionResponse alice, SessionResponse bob) {
        UUID chatId = UUID.randomUUID();
        migrator().update("""
                INSERT INTO chat.chats
                       (id, workspace_id, type, security_mode, name, created_by, direct_key)
                VALUES (?, ?, 'DIRECT', 'E2EE', 'e2ee-chat', ?, ?)
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

    private org.springframework.test.web.servlet.ResultActions patchChat(
            SessionResponse actor, UUID chatId, Map<String, Object> body) throws Exception {
        return mockMvc.perform(authed(patch("/api/v1/chats/{chatId}", chatId), actor)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(body)));
    }

    private void assertE2eeUnsupported(
            org.springframework.test.web.servlet.ResultActions actions) throws Exception {
        MvcResult result = actions.andExpect(status().isUnprocessableEntity()).andReturn();
        JsonNode body = json(result);
        CONTRACT.assertValid("Error", body);
        assertThat(body.get("code").asText()).isEqualTo("CHAT_SETTINGS_E2EE_UNSUPPORTED");
    }

    private long auditCount(UUID chatId) {
        Long count = migrator().queryForObject("""
                SELECT count(*) FROM audit.audit_events
                 WHERE action = 'chat.updated' AND target_id = ?
                """, Long.class, chatId);
        return count == null ? 0 : count;
    }
}
