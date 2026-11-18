package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;

@ActiveProfiles("test")
class CrossTenantIT extends IntegrationTestBase {

    @Test
    void foreignWorkspaceListReturns403() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();

        MvcResult result = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{workspaceId}/chats", bob.workspace().id()), alice))
                .andExpect(status().isForbidden())
                .andReturn();
        assertThat(json(result).get("code").asText()).isEqualTo("FORBIDDEN");

        MvcResult sync = mockMvc.perform(authed(get("/api/v1/sync"), alice)
                        .param("workspace_id", bob.workspace().id().toString()))
                .andExpect(status().isForbidden())
                .andReturn();
        assertThat(json(sync).get("code").asText()).isEqualTo("FORBIDDEN");
    }

    @Test
    void foreignChatReturns404AndIsNotDisclosed() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        sendMessage(bob, bob.chat().id(), UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), "bob message");

        MvcResult list = mockMvc.perform(authed(
                        get("/api/v1/chats/{chatId}/messages", bob.chat().id()), alice))
                .andExpect(status().isNotFound())
                .andReturn();
        assertThat(json(list).get("code").asText()).isEqualTo("NOT_FOUND");

        MvcResult send = mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/messages", bob.chat().id()), alice)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(messageBody(UUID.randomUUID().toString(), "intrusion", null)))
                .andExpect(status().isNotFound())
                .andReturn();
        assertThat(json(send).get("code").asText()).isEqualTo("NOT_FOUND");

        MvcResult read = mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/read", bob.chat().id()), alice)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"last_seq\":0}"))
                .andExpect(status().isNotFound())
                .andReturn();
        assertThat(json(read).get("code").asText()).isEqualTo("NOT_FOUND");

        assertThat(messageCount(bob.chat().id())).isEqualTo(1);
    }

    @Test
    void listContainsOnlyChatsWhereUserIsAnActiveMember() throws Exception {
        SessionResponse alice = devSession();
        UUID workspaceId = alice.workspace().id();
        UUID userId = alice.user().id();
        UUID extraChatId = UUID.randomUUID();

        migrator().update("""
                INSERT INTO chat.chats (id, workspace_id, type, security_mode, name, created_by)
                VALUES (?, ?, 'GROUP', 'MANAGED', 'extra', ?)
                """, extraChatId, workspaceId, userId);
        migrator().update("""
                INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
                VALUES (?, ?, ?, 'MEMBER', 'INVITED')
                """, extraChatId, workspaceId, userId);
        migrator().update("""
                INSERT INTO chat.chat_counters (chat_id, workspace_id) VALUES (?, ?)
                """, extraChatId, workspaceId);

        assertThat(chatIds(alice)).doesNotContain(extraChatId);

        migrator().update("UPDATE chat.chat_members SET status = 'ACTIVE'"
                        + " WHERE chat_id = ? AND user_id = ?", extraChatId, userId);
        assertThat(chatIds(alice)).contains(extraChatId);

        migrator().update("UPDATE chat.chat_members SET status = 'REMOVED'"
                        + " WHERE chat_id = ? AND user_id = ?", extraChatId, userId);
        assertThat(chatIds(alice)).doesNotContain(extraChatId);

        assertThat(chatList(alice).get("items").size()).isEqualTo(1);
    }

    private java.util.List<UUID> chatIds(SessionResponse session) throws Exception {
        JsonNode body = chatList(session);
        java.util.List<UUID> ids = new java.util.ArrayList<>();
        body.get("items").forEach(item -> ids.add(UUID.fromString(item.get("id").asText())));
        return ids;
    }
}
