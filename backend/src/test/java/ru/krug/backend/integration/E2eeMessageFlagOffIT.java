package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;

import ru.krug.backend.chat.domain.service.DirectPairKey;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.shared.application.model.IssuedToken;
import ru.krug.backend.shared.application.port.TokenIssuer;
import ru.krug.backend.support.IntegrationTestBase;

/**
 * E7-B3: with {@code krug.e2ee.enabled=false} an existing E2EE workspace/chat is never
 * quietly downgraded and never accepts plaintext. Chat creation and every message operation
 * answer {@code 409 E2EE_DISABLED} before anything is stored.
 */
@ActiveProfiles("test")
class E2eeMessageFlagOffIT extends IntegrationTestBase {

    @Autowired
    private TokenIssuer tokenIssuer;

    @Test
    void e2eeChatAndMessagesStayDisabledWhenTheFlagIsOff() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        UUID workspaceId = createE2eeWorkspace(alice, bob);
        UUID chatId = createE2eeDirect(alice, bob, workspaceId);
        SessionResponse aliceInWorkspace = withWorkspace(alice, workspaceId);

        // Chat creation in an existing E2EE workspace is disabled.
        JsonNode createError = json(mockMvc.perform(authed(
                        post("/api/v1/workspaces/{id}/chats", workspaceId), alice)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("type", "DIRECT",
                                "peer_id", bob.user().id().toString()))))
                .andExpect(status().isConflict())
                .andReturn());
        assertThat(createError.get("code").asText()).isEqualTo("E2EE_DISABLED");

        // A malformed envelope still answers E2EE_DISABLED (the flag is checked first).
        JsonNode sendError = json(mockMvc.perform(authed(
                        post("/api/v1/chats/{id}/messages", chatId), aliceInWorkspace)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "client_message_id", UUID.randomUUID().toString(),
                                "type", "TEXT",
                                "envelopes", List.of(Map.of("v", 1))))))
                .andExpect(status().isConflict())
                .andReturn());
        assertThat(sendError.get("code").asText()).isEqualTo("E2EE_DISABLED");

        // Plaintext in an E2EE chat is never a fallback.
        JsonNode plaintext = json(mockMvc.perform(authed(
                        post("/api/v1/chats/{id}/messages", chatId), aliceInWorkspace)
                        .header("Idempotency-Key", UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "client_message_id", UUID.randomUUID().toString(),
                                "type", "TEXT", "text", "must not be stored"))))
                .andExpect(status().isConflict())
                .andReturn());
        assertThat(plaintext.get("code").asText()).isEqualTo("E2EE_DISABLED");

        JsonNode readError = json(mockMvc.perform(authed(
                        get("/api/v1/chats/{id}/messages", chatId), aliceInWorkspace))
                .andExpect(status().isConflict())
                .andReturn());
        assertThat(readError.get("code").asText()).isEqualTo("E2EE_DISABLED");
        assertThat(messageCount(chatId)).isZero();
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM message.message_envelopes WHERE chat_id = ?
                """, Integer.class, chatId)).isZero();
    }

    // ---------------------------------------------------------------------

    private SessionResponse withWorkspace(SessionResponse session, UUID workspaceId) {
        IssuedToken token = tokenIssuer.issue(session.user().id(), session.device().id(),
                workspaceId);
        return new SessionResponse(token.accessToken(), token.expiresAt(), session.user(),
                session.device(), session.workspace(), session.chat());
    }

    private UUID createE2eeWorkspace(SessionResponse owner, SessionResponse member) {
        UUID workspaceId = UUID.randomUUID();
        migrator().update("""
                INSERT INTO workspace.workspaces (id, name, slug, security_mode, created_by)
                VALUES (?, ?, ?, 'E2EE', ?)
                """, workspaceId, "flag-off e2ee", "flag-off-" + workspaceId,
                owner.user().id());
        for (SessionResponse session : List.of(owner, member)) {
            migrator().update("""
                    INSERT INTO workspace.memberships (workspace_id, user_id, role, status)
                    VALUES (?, ?, ?, 'ACTIVE')
                    """, workspaceId, session.user().id(),
                    session == owner ? "OWNER" : "MEMBER");
        }
        return workspaceId;
    }

    private UUID createE2eeDirect(SessionResponse alice, SessionResponse bob, UUID workspaceId) {
        UUID chatId = UUID.randomUUID();
        migrator().update("""
                INSERT INTO chat.chats
                       (id, workspace_id, type, security_mode, name, created_by, direct_key)
                VALUES (?, ?, 'DIRECT', 'E2EE', NULL, ?, ?)
                """, chatId, workspaceId, alice.user().id(),
                DirectPairKey.of(alice.user().id(), bob.user().id()));
        for (SessionResponse member : List.of(alice, bob)) {
            migrator().update("""
                    INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
                    VALUES (?, ?, ?, ?, 'ACTIVE')
                    """, chatId, workspaceId, member.user().id(),
                    member == alice ? "OWNER" : "MEMBER");
        }
        migrator().update("INSERT INTO chat.chat_counters (chat_id, workspace_id) VALUES (?, ?)",
                chatId, workspaceId);
        return chatId;
    }
}
