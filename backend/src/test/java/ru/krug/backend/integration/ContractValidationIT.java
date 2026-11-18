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
import ru.krug.backend.support.OpenApiContract;

/**
 * Validates real HTTP responses against contracts/openapi.yaml component schemas.
 */
@ActiveProfiles("test")
class ContractValidationIT extends IntegrationTestBase {

    private static final OpenApiContract CONTRACT = OpenApiContract.load();

    @Test
    void sessionChatListMessagePageAndSyncMatchTheContract() throws Exception {
        String displayName = uniqueDisplayName("contract");
        MvcResult sessionResult = mockMvc.perform(post("/api/v1/dev/session")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                java.util.Map.of("display_name", displayName))))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode sessionNode = json(sessionResult);
        CONTRACT.assertValid("Session", sessionNode);
        SessionResponse session = objectMapper.readValue(sessionResult.getResponse().getContentAsString(),
                SessionResponse.class);

        MvcResult listResult = mockMvc.perform(authed(
                        get("/api/v1/workspaces/{id}/chats", session.workspace().id()), session))
                .andExpect(status().isOk())
                .andReturn();
        CONTRACT.assertValid("ChatList", json(listResult));

        String key = UUID.randomUUID().toString();
        String clientId = UUID.randomUUID().toString();
        MvcResult sendResult = mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/messages", session.chat().id()), session)
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(messageBody(clientId, "contract", null)))
                .andExpect(status().isCreated())
                .andReturn();
        CONTRACT.assertValid("Message", json(sendResult));

        MvcResult pageResult = mockMvc.perform(authed(
                        get("/api/v1/chats/{chatId}/messages", session.chat().id()), session))
                .andExpect(status().isOk())
                .andReturn();
        CONTRACT.assertValid("MessagePage", json(pageResult));

        MvcResult syncResult = mockMvc.perform(authed(get("/api/v1/sync"), session)
                        .param("workspace_id", session.workspace().id().toString()))
                .andExpect(status().isOk())
                .andReturn();
        CONTRACT.assertValid("SyncResponse", json(syncResult));

        MvcResult replay = mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/messages", session.chat().id()), session)
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(messageBody(clientId, "contract", null)))
                .andExpect(status().isCreated())
                .andReturn();
        CONTRACT.assertValid("Message", json(replay));
    }

    @Test
    void threadFieldsAndSummaryMatchTheContract() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        JsonNode root = sendMessage(session, chatId, UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), "root");
        CONTRACT.assertValid("Message", root);
        assertThat(root.get("thread_root_id").isNull()).isTrue();
        assertThat(root.get("thread_summary").isNull()).isTrue();

        String body = objectMapper.writeValueAsString(java.util.Map.of(
                "client_message_id", UUID.randomUUID().toString(),
                "type", "TEXT",
                "text", "reply",
                "thread_root_id", root.get("id").asText()));
        MvcResult replyResult = mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/messages", chatId), session)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isCreated())
                .andReturn();
        CONTRACT.assertValid("Message", json(replyResult));
        assertThat(json(replyResult).get("thread_root_id").asText())
                .isEqualTo(root.get("id").asText());

        MvcResult threadPage = mockMvc.perform(authed(
                        get("/api/v1/chats/{chatId}/messages", chatId), session)
                        .param("thread_root_id", root.get("id").asText()))
                .andExpect(status().isOk())
                .andReturn();
        CONTRACT.assertValid("MessagePage", json(threadPage));

        MvcResult mainPage = mockMvc.perform(authed(
                        get("/api/v1/chats/{chatId}/messages", chatId), session))
                .andExpect(status().isOk())
                .andReturn();
        CONTRACT.assertValid("MessagePage", json(mainPage));
        JsonNode summary = json(mainPage).get("items").get(0).get("thread_summary");
        assertThat(summary.get("reply_count").asInt()).isEqualTo(1);
        assertThat(summary.get("last_reply_excerpt").asText()).isEqualTo("reply");
        assertThat(summary.has("last_reply_at")).isTrue();
        assertThat(summary.has("last_reply_author_id")).isTrue();
    }

    @Test
    void errorEnvelopesMatchTheContract() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();

        MvcResult notFound = mockMvc.perform(authed(
                        get("/api/v1/chats/{chatId}/messages", bob.chat().id()), alice))
                .andExpect(status().isNotFound())
                .andReturn();
        CONTRACT.assertValid("Error", json(notFound));

        String key = UUID.randomUUID().toString();
        String clientId = UUID.randomUUID().toString();
        mockMvc.perform(authed(post("/api/v1/chats/{chatId}/messages", alice.chat().id()), alice)
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(messageBody(clientId, "one", null)))
                .andExpect(status().isCreated());

        MvcResult conflict = mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/messages", alice.chat().id()), alice)
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(messageBody(clientId, "two", null)))
                .andExpect(status().isConflict())
                .andReturn();
        CONTRACT.assertValid("Error", json(conflict));

        MvcResult unauthorized = mockMvc.perform(get("/api/v1/sync")
                        .param("workspace_id", UUID.randomUUID().toString()))
                .andExpect(status().isUnauthorized())
                .andReturn();
        CONTRACT.assertValid("Error", json(unauthorized));
    }

    @Test
    void healthMatchesItsInlineSchema() throws Exception {
        MvcResult result = mockMvc.perform(get("/api/v1/health"))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode body = json(result);
        assertThat(body.get("status").asText()).isEqualTo("ok");
    }
}
