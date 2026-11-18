package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.Locale;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.message.application.model.MessagePageCursor;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;

@ActiveProfiles("test")
class MessageApiIT extends IntegrationTestBase {

    @Test
    void sendsTextMessageAndAssignsMonotonicSeq() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();

        JsonNode first = sendMessage(session, chatId, randomKey(),
                UUID.randomUUID().toString(), "первое");
        JsonNode second = sendMessage(session, chatId, randomKey(),
                UUID.randomUUID().toString(), "второе");

        assertThat(first.get("seq").asLong()).isEqualTo(1);
        assertThat(second.get("seq").asLong()).isEqualTo(2);
        assertThat(first.get("type").asText()).isEqualTo("TEXT");
        assertThat(first.get("text").asText()).isEqualTo("первое");
        assertThat(first.get("sender_id").asText()).isEqualTo(session.user().id().toString());
        assertThat(first.get("sender_display_name").asText()).isEqualTo(session.user().displayName());
        assertThat(first.get("version").asInt()).isEqualTo(1);
        assertThat(first.get("chat_id").asText()).isEqualTo(chatId.toString());
        assertThat(first.get("created_at").asText()).isNotBlank();
        assertThat(first.get("id").asText()).isNotBlank();
    }

    @Test
    void pagesBySeqInBothDirections() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        sendMessage(session, chatId, randomKey(), UUID.randomUUID().toString(), "one");
        sendMessage(session, chatId, randomKey(), UUID.randomUUID().toString(), "two");

        JsonNode defaultPage = getMessages(session, chatId, null, null, null);
        assertThat(defaultPage.get("items").size()).isEqualTo(2);
        assertThat(defaultPage.get("items").get(0).get("seq").asLong()).isEqualTo(2);
        assertThat(defaultPage.get("items").get(1).get("seq").asLong()).isEqualTo(1);
        assertThat(defaultPage.get("page").get("has_more").asBoolean()).isFalse();
        assertThat(defaultPage.get("page").get("next_cursor").isNull()).isTrue();

        JsonNode after = getMessages(session, chatId, 1L, null, null);
        assertThat(after.get("items").size()).isEqualTo(1);
        assertThat(after.get("items").get(0).get("seq").asLong()).isEqualTo(2);
        assertThat(after.get("page").get("has_more").asBoolean()).isFalse();

        JsonNode limitOne = getMessages(session, chatId, null, null, 1);
        assertThat(limitOne.get("items").size()).isEqualTo(1);
        assertThat(limitOne.get("items").get(0).get("seq").asLong()).isEqualTo(2);
        assertThat(limitOne.get("page").get("has_more").asBoolean()).isTrue();
        String cursor = limitOne.get("page").get("next_cursor").asText();
        assertThat(MessagePageCursor.decode(cursor).seq()).isEqualTo(2);

        JsonNode before = getMessages(session, chatId, null, 2L, null);
        assertThat(before.get("items").size()).isEqualTo(1);
        assertThat(before.get("items").get(0).get("seq").asLong()).isEqualTo(1);
        assertThat(before.get("page").get("has_more").asBoolean()).isFalse();
    }

    @Test
    void supportsReplyToMessageInSameChat() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        JsonNode root = sendMessage(session, chatId, randomKey(),
                UUID.randomUUID().toString(), "root");

        MvcResult result = mockMvc.perform(authed(post("/api/v1/chats/{chatId}/messages", chatId), session)
                        .header("Idempotency-Key", randomKey())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(messageBody(UUID.randomUUID().toString(), "reply",
                                UUID.fromString(root.get("id").asText()))))
                .andExpect(status().isCreated())
                .andReturn();
        JsonNode reply = json(result);
        assertThat(reply.get("reply_to_id").asText()).isEqualTo(root.get("id").asText());
        assertThat(reply.get("seq").asLong()).isEqualTo(2);
    }

    @Test
    void rejectsReplyToMessageFromAnotherChat() throws Exception {
        SessionResponse first = devSession();
        SessionResponse second = devSession();
        JsonNode foreign = sendMessage(second, second.chat().id(), randomKey(),
                UUID.randomUUID().toString(), "elsewhere");

        MvcResult result = mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/messages", first.chat().id()), first)
                        .header("Idempotency-Key", randomKey())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(messageBody(UUID.randomUUID().toString(), "reply",
                                UUID.fromString(foreign.get("id").asText()))))
                .andExpect(status().isUnprocessableEntity())
                .andReturn();
        assertThat(json(result).get("code").asText()).isEqualTo("VALIDATION_FAILED");
        assertThat(json(result).get("details").get("field").asText()).isEqualTo("reply_to_id");
    }

    @Test
    void validatesMessageSemantics() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();

        assertSendError(session, chatId, UUID.randomUUID().toString(), "x".repeat(8001),
                422, "MESSAGE_TOO_LONG");
        assertSendError(session, chatId, UUID.randomUUID().toString(), "   ",
                422, "VALIDATION_FAILED");

        MvcResult invalidSticker = mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/messages", chatId), session)
                        .header("Idempotency-Key", randomKey())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"client_message_id":"%s","type":"STICKER","text":"x"}
                                """.formatted(UUID.randomUUID())))
                .andExpect(status().isUnprocessableEntity())
                .andReturn();
        assertThat(json(invalidSticker).get("code").asText())
                .isEqualTo("INVALID_STICKER_MESSAGE");

        mockMvc.perform(authed(post("/api/v1/chats/{chatId}/messages", chatId), session)
                        .header("Idempotency-Key", randomKey())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"type":"TEXT","text":"x"}
                                """))
                .andExpect(status().isBadRequest());

        mockMvc.perform(authed(post("/api/v1/chats/{chatId}/messages", chatId), session)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(messageBody(UUID.randomUUID().toString(), "no key", null)))
                .andExpect(status().isBadRequest());

        mockMvc.perform(authed(post("/api/v1/chats/{chatId}/messages", chatId), session)
                        .header("Idempotency-Key", "not-a-uuid")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(messageBody(UUID.randomUUID().toString(), "bad key", null)))
                .andExpect(status().isBadRequest());
    }

    @Test
    void readReceiptIsMonotonicAndDrivesUnreadCount() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        sendMessage(session, chatId, randomKey(), UUID.randomUUID().toString(), "one");
        sendMessage(session, chatId, randomKey(), UUID.randomUUID().toString(), "two");

        JsonNode chats = chatList(session);
        assertThat(chats.get("items").get(0).get("last_seq").asLong()).isEqualTo(2);
        assertThat(chats.get("items").get(0).get("unread_count").asLong()).isEqualTo(2);

        markRead(session, chatId, 1).andExpect(status().isNoContent());
        assertThat(chatList(session).get("items").get(0).get("unread_count").asLong()).isEqualTo(1);

        markRead(session, chatId, 0).andExpect(status().isNoContent());
        assertThat(chatList(session).get("items").get(0).get("unread_count").asLong()).isEqualTo(1);

        assertThat(sync(session).get("chats").get(0).get("unread_count").asLong()).isEqualTo(1);
        assertThat(sync(session).get("server_time").asText()).isNotBlank();

        MvcResult outOfRange = markRead(session, chatId, 99)
                .andExpect(status().isUnprocessableEntity())
                .andReturn();
        assertThat(json(outOfRange).get("code").asText()).isEqualTo("SEQ_OUT_OF_RANGE");

        markRead(session, chatId, 2).andExpect(status().isNoContent());
        assertThat(chatList(session).get("items").get(0).get("unread_count").asLong()).isZero();
    }

    @Test
    void rejectsInvalidPaginationParameters() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        sendMessage(session, chatId, randomKey(), UUID.randomUUID().toString(), "x");

        mockMvc.perform(authed(get("/api/v1/chats/{chatId}/messages", chatId), session)
                        .param("limit", "0"))
                .andExpect(status().isBadRequest());
        mockMvc.perform(authed(get("/api/v1/chats/{chatId}/messages", chatId), session)
                        .param("limit", "101"))
                .andExpect(status().isBadRequest());
        mockMvc.perform(authed(get("/api/v1/chats/{chatId}/messages", chatId), session)
                        .param("after_seq", "-1"))
                .andExpect(status().isBadRequest());
        mockMvc.perform(authed(get("/api/v1/chats/{chatId}/messages", chatId), session)
                        .param("limit", "abc"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void readReceiptRequiresIdempotencyKey() throws Exception {
        SessionResponse session = devSession();
        MvcResult result = mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/read", session.chat().id()), session)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"last_seq\":0}"))
                .andExpect(status().isBadRequest())
                .andReturn();
        assertThat(json(result).get("code").asText()).isEqualTo("VALIDATION_FAILED");
    }

    @Test
    void readReceiptRejectsMissingOrNegativeLastSeq() throws Exception {
        SessionResponse session = devSession();
        mockMvc.perform(authed(post("/api/v1/chats/{chatId}/read", session.chat().id()), session)
                        .header("Idempotency-Key", randomKey())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isBadRequest());
        mockMvc.perform(authed(post("/api/v1/chats/{chatId}/read", session.chat().id()), session)
                        .header("Idempotency-Key", randomKey())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"last_seq\":-1}"))
                .andExpect(status().isBadRequest());
    }

    /**
     * E2EE-REVIEW-07 P2-06: request-level UUIDs are canonicalized explicitly. An upper-case
     * {@code client_message_id} must produce the same lower-case UUID in the response and
     * in the idempotency fingerprint, never a second message; lenient forms stay 400.
     */
    @Test
    void canonicalizesClientMessageIdCaseAndKeepsIdempotencyConsistent() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        UUID clientMessageId = UUID.randomUUID();
        String lower = clientMessageId.toString();
        String upper = lower.toUpperCase(Locale.ROOT);
        UUID idempotencyKey = UUID.randomUUID();

        JsonNode first = sendWithClientId(session, chatId, idempotencyKey, lower, 201);
        UUID messageId = UUID.fromString(first.get("id").asText());
        assertThat(first.get("client_message_id").asText()).isEqualTo(lower);

        // Same Idempotency-Key, upper-case UUID: the canonical hash must replay the same
        // message instead of creating a second one.
        MvcResult replayed = postWithClientId(session, chatId, idempotencyKey, upper);
        assertThat(replayed.getResponse().getStatus()).isEqualTo(201);
        assertThat(replayed.getResponse().getHeader("Idempotent-Replay")).isEqualTo("true");
        JsonNode replayedJson = json(replayed);
        assertThat(replayedJson.get("id").asText()).isEqualTo(messageId.toString());
        assertThat(replayedJson.get("client_message_id").asText()).isEqualTo(lower);

        // A new Idempotency-Key with the same (case-different) client_message_id is still
        // the same message, not a conflict.
        JsonNode byClientId = sendWithClientId(session, chatId, UUID.randomUUID(), upper, 201);
        assertThat(byClientId.get("id").asText()).isEqualTo(messageId.toString());
        assertThat(byClientId.get("client_message_id").asText()).isEqualTo(lower);
        assertThat(messageCount(chatId)).isEqualTo(1);

        // The explicitly accepted wire shape is still 8-4-4-4-12; lenient UUIDs are 400.
        MvcResult lenient = postWithClientId(session, chatId, UUID.randomUUID(), "1-1-1-1-1");
        assertThat(lenient.getResponse().getStatus()).isEqualTo(400);
        assertThat(json(lenient).get("code").asText()).isEqualTo("VALIDATION_FAILED");
        assertThat(messageCount(chatId)).isEqualTo(1);
    }

    private JsonNode sendWithClientId(SessionResponse session, UUID chatId, UUID idempotencyKey,
                                      String clientMessageId, int expected) throws Exception {
        MvcResult result = postWithClientId(session, chatId, idempotencyKey, clientMessageId);
        assertThat(result.getResponse().getStatus()).isEqualTo(expected);
        return json(result);
    }

    private MvcResult postWithClientId(SessionResponse session, UUID chatId,
                                       UUID idempotencyKey, String clientMessageId)
            throws Exception {
        return mockMvc.perform(authed(post("/api/v1/chats/{chatId}/messages", chatId), session)
                        .header("Idempotency-Key", idempotencyKey.toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(messageBody(clientMessageId, "canonical", null)))
                .andReturn();
    }

    private JsonNode getMessages(SessionResponse session, UUID chatId, Long afterSeq,
                                 Long beforeSeq, Integer limit) throws Exception {
        var request = authed(get("/api/v1/chats/{chatId}/messages", chatId), session);
        if (afterSeq != null) {
            request.param("after_seq", afterSeq.toString());
        }
        if (beforeSeq != null) {
            request.param("before_seq", beforeSeq.toString());
        }
        if (limit != null) {
            request.param("limit", limit.toString());
        }
        MvcResult result = mockMvc.perform(request).andExpect(status().isOk()).andReturn();
        return json(result);
    }

    private org.springframework.test.web.servlet.ResultActions markRead(SessionResponse session,
                                                                         UUID chatId, long lastSeq)
            throws Exception {
        return mockMvc.perform(authed(post("/api/v1/chats/{chatId}/read", chatId), session)
                .header("Idempotency-Key", randomKey())
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"last_seq\":" + lastSeq + "}"));
    }

    private JsonNode sync(SessionResponse session) throws Exception {
        MvcResult result = mockMvc.perform(authed(get("/api/v1/sync"), session)
                        .param("workspace_id", session.workspace().id().toString()))
                .andExpect(status().isOk())
                .andReturn();
        return json(result);
    }

    private static String randomKey() {
        return UUID.randomUUID().toString();
    }

    private void assertSendError(SessionResponse session, UUID chatId, String clientMessageId,
                                 String text, int status, String code) throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        post("/api/v1/chats/{chatId}/messages", chatId), session)
                        .header("Idempotency-Key", randomKey())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(messageBody(clientMessageId, text, null)))
                .andExpect(status().is(status))
                .andReturn();
        assertThat(json(result).get("code").asText()).isEqualTo(code);
        assertThat(json(result).get("request_id").asText()).isNotBlank();
    }
}
