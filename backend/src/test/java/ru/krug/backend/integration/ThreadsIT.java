package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessException;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.message.domain.model.ThreadSummary;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;

/**
 * D1-BE1 — flat threads: send/list/summary/validation/idempotency/RLS/index/DB backstop.
 *
 * <p>Depth is one: a reply is a normal managed message with {@code thread_root_id}; the
 * main feed never contains replies, and {@code thread_summary} is attached to roots only.
 */
@ActiveProfiles("test")
class ThreadsIT extends IntegrationTestBase {

    @Test
    void sendReplyAndListThreadSeparatelyFromMainFeed() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();

        JsonNode root = sendMessage(session, chatId, randomKey(),
                UUID.randomUUID().toString(), "root");
        UUID rootId = UUID.fromString(root.get("id").asText());
        JsonNode reply1 = sendReply(session, chatId, rootId, "reply-one", 201);
        JsonNode reply2 = sendReply(session, chatId, rootId, "reply-two", 201);

        assertThat(root.get("thread_root_id").isNull()).isTrue();
        assertThat(root.get("thread_summary").isNull()).isTrue();
        assertThat(reply1.get("thread_root_id").asText()).isEqualTo(rootId.toString());
        assertThat(reply2.get("thread_root_id").asText()).isEqualTo(rootId.toString());
        assertThat(reply1.get("thread_summary").isNull()).isTrue();
        assertThat(reply1.get("seq").asLong()).isEqualTo(2);
        assertThat(reply2.get("seq").asLong()).isEqualTo(3);

        // No thread_root_id: main feed only (roots), replies are invisible here.
        JsonNode mainFeed = getMessages(session, chatId, null, null, null, null);
        assertThat(mainFeed.get("items").size()).isEqualTo(1);
        assertThat(mainFeed.get("items").get(0).get("id").asText()).isEqualTo(rootId.toString());
        assertThat(mainFeed.get("items").get(0).get("thread_root_id").isNull()).isTrue();

        // thread_root_id: exactly the replies, default page is seq DESC.
        JsonNode thread = getMessages(session, chatId, null, null, null, rootId);
        assertThat(thread.get("items").size()).isEqualTo(2);
        assertThat(seqs(thread)).containsExactly(3L, 2L);
        assertThat(thread.get("items").get(0).get("thread_root_id").asText())
                .isEqualTo(rootId.toString());
        assertThat(thread.get("items").get(0).get("text").asText()).isEqualTo("reply-two");

        // Forward pagination from the root's seq.
        JsonNode after = getMessages(session, chatId, 1L, null, null, rootId);
        assertThat(seqs(after)).containsExactly(2L, 3L);

        // Cursor + limit on a thread page.
        JsonNode limitOne = getMessages(session, chatId, null, null, 1, rootId);
        assertThat(limitOne.get("items").size()).isEqualTo(1);
        assertThat(limitOne.get("items").get(0).get("seq").asLong()).isEqualTo(3);
        assertThat(limitOne.get("page").get("has_more").asBoolean()).isTrue();
        String cursor = limitOne.get("page").get("next_cursor").asText();
        assertThat(cursor).isNotBlank();

        JsonNode before = getMessages(session, chatId, null, 3L, null, rootId);
        assertThat(seqs(before)).containsExactly(2L);
        assertThat(before.get("page").get("has_more").asBoolean()).isFalse();

        // A root without replies is a valid, empty thread page.
        JsonNode secondRoot = sendMessage(session, chatId, randomKey(),
                UUID.randomUUID().toString(), "root-without-replies");
        JsonNode secondRootFeed = mainFeed(session, chatId)
                .byId(UUID.fromString(secondRoot.get("id").asText()));
        assertThat(secondRootFeed.get("thread_summary").get("reply_count").asInt()).isZero();
        assertThat(secondRootFeed.get("thread_summary").get("last_reply_at").isNull()).isTrue();
        assertThat(secondRootFeed.get("thread_summary").get("last_reply_excerpt").isNull())
                .isTrue();
        JsonNode emptyThread = getMessages(session, chatId, null, null, null,
                UUID.fromString(secondRoot.get("id").asText()));
        assertThat(emptyThread.get("items").size()).isZero();
        assertThat(emptyThread.get("page").get("has_more").asBoolean()).isFalse();

        // A reply still participates in the chat seq/unread stream (unchanged behaviour).
        assertThat(chatList(session).get("items").get(0).get("last_seq").asLong()).isEqualTo(4);
    }

    @Test
    void summaryCountsRepliesAndExcerptIsManagedAndTruncated() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        UUID rootId = UUID.fromString(sendMessage(session, chatId, randomKey(),
                UUID.randomUUID().toString(), "root").get("id").asText());
        sendReply(session, chatId, rootId, "первый ответ", 201);
        String longReply = "  строка\n" + "я".repeat(200) + "  ";
        sendReply(session, chatId, rootId, longReply, 201);

        Page page = mainFeed(session, chatId);
        JsonNode root = page.byId(rootId);
        JsonNode summary = root.get("thread_summary");
        assertThat(summary).isNotNull();
        assertThat(summary.get("reply_count").asInt()).isEqualTo(2);
        assertThat(summary.get("last_reply_at").asText()).isNotBlank();
        assertThat(summary.get("last_reply_author_id").asText())
                .isEqualTo(session.user().id().toString());
        String excerpt = summary.get("last_reply_excerpt").asText();
        assertThat(excerpt).doesNotContain("\n").hasSize(160);
        assertThat(excerpt).startsWith("строка я");
        assertThat(excerpt).isEqualTo(ThreadSummary.excerpt(longReply));

        // The reply itself never carries a summary.
        JsonNode thread = getMessages(session, chatId, null, null, null, rootId);
        assertThat(thread.get("items").get(0).get("thread_summary").isNull()).isTrue();

        // Roots without replies still carry a zero summary; replies never do.
        UUID secondRoot = UUID.fromString(sendMessage(session, chatId, randomKey(),
                UUID.randomUUID().toString(), "no-replies").get("id").asText());
        JsonNode emptySummary = mainFeed(session, chatId).byId(secondRoot)
                .get("thread_summary");
        assertThat(emptySummary.get("reply_count").asInt()).isZero();
        assertThat(emptySummary.get("last_reply_at").isNull()).isTrue();
        assertThat(emptySummary.get("last_reply_author_id").isNull()).isTrue();
        assertThat(emptySummary.get("last_reply_excerpt").isNull()).isTrue();

        // Deleting the last reply makes the previous live reply the preview source.
        UUID lastReplyId = UUID.fromString(thread.get("items").get(0).get("id").asText());
        migrator().update("UPDATE message.messages SET deleted_at = now() WHERE id = ?",
                lastReplyId);
        summary = mainFeed(session, chatId).byId(rootId).get("thread_summary");
        assertThat(summary.get("reply_count").asInt()).isEqualTo(1);
        assertThat(summary.get("last_reply_excerpt").asText()).isEqualTo("первый ответ");
    }

    @Test
    void rejectsInvalidThreadRootsWithTypedErrors() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        UUID rootId = UUID.fromString(sendMessage(session, chatId, randomKey(),
                UUID.randomUUID().toString(), "root").get("id").asText());
        JsonNode reply = sendReply(session, chatId, rootId, "reply", 201);
        UUID replyId = UUID.fromString(reply.get("id").asText());
        long messagesBefore = messageCount(chatId);

        // Unknown root.
        assertThreadError(session, chatId, UUID.randomUUID(), 422, "THREAD_ROOT_NOT_FOUND");
        // Root from another chat in the same workspace.
        UUID otherChat = secondChat(session);
        UUID foreignRoot = UUID.fromString(sendMessage(session, otherChat, randomKey(),
                UUID.randomUUID().toString(), "foreign-root").get("id").asText());
        assertThreadError(session, chatId, foreignRoot, 422, "THREAD_ROOT_NOT_FOUND");
        // Root from another workspace.
        SessionResponse stranger = devSession();
        UUID strangerRoot = UUID.fromString(sendMessage(stranger, stranger.chat().id(),
                randomKey(), UUID.randomUUID().toString(), "stranger-root").get("id").asText());
        assertThreadError(session, chatId, strangerRoot, 422, "THREAD_ROOT_NOT_FOUND");
        // A reply cannot be used as a root: no nesting.
        assertThreadError(session, chatId, replyId, 422, "THREAD_NESTING_UNSUPPORTED");
        // Deleted root.
        migrator().update("UPDATE message.messages SET deleted_at = now() WHERE id = ?", rootId);
        assertThreadError(session, chatId, rootId, 422, "THREAD_ROOT_DELETED");

        // Thread listing applies the same root validation.
        assertThreadListError(session, chatId, replyId, 422, "THREAD_NESTING_UNSUPPORTED");
        assertThreadListError(session, chatId, rootId, 422, "THREAD_ROOT_DELETED");
        assertThreadListError(session, chatId, UUID.randomUUID(), 422,
                "THREAD_ROOT_NOT_FOUND");

        // Invalid requests never allocate seq or create a row.
        assertThat(messageCount(chatId)).isEqualTo(messagesBefore);
    }

    @Test
    void threadRootParticipatesInIdempotencyAndClientMessageIdConflicts() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        UUID rootA = UUID.fromString(sendMessage(session, chatId, randomKey(),
                UUID.randomUUID().toString(), "root-a").get("id").asText());
        UUID rootB = UUID.fromString(sendMessage(session, chatId, randomKey(),
                UUID.randomUUID().toString(), "root-b").get("id").asText());

        UUID idempotencyKey = UUID.randomUUID();
        String clientMessageId = UUID.randomUUID().toString();
        JsonNode first = sendReply(session, chatId, rootA, "idem", 201, idempotencyKey,
                clientMessageId);
        MvcResult replay = postReply(session, chatId, rootA, "idem", idempotencyKey,
                clientMessageId);
        assertThat(replay.getResponse().getStatus()).isEqualTo(201);
        assertThat(replay.getResponse().getHeader("Idempotent-Replay")).isEqualTo("true");
        assertThat(json(replay).get("id").asText()).isEqualTo(first.get("id").asText());
        assertThat(json(replay).get("thread_root_id").asText())
                .isEqualTo(rootA.toString());

        // Same Idempotency-Key but a different thread root -> hash mismatch, not a replay.
        MvcResult reused = postReply(session, chatId, rootB, "idem", idempotencyKey,
                clientMessageId);
        assertThat(reused.getResponse().getStatus()).isEqualTo(409);
        assertThat(json(reused).get("code").asText()).isEqualTo("IDEMPOTENCY_KEY_REUSED");

        // Same client_message_id with another root -> conflict, not a silent second thread.
        MvcResult conflict = postReply(session, chatId, rootB, "idem", UUID.randomUUID(),
                clientMessageId);
        assertThat(conflict.getResponse().getStatus()).isEqualTo(409);
        assertThat(json(conflict).get("code").asText()).isEqualTo("CLIENT_MESSAGE_ID_CONFLICT");
        assertThat(messageCount(chatId)).isEqualTo(3);
    }

    @Test
    void threadSchemaHasIndexAndDatabaseBackstop() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        UUID rootId = UUID.fromString(sendMessage(session, chatId, randomKey(),
                UUID.randomUUID().toString(), "root").get("id").asText());
        UUID replyId = UUID.fromString(sendReply(session, chatId, rootId, "reply", 201)
                .get("id").asText());
        UUID otherChat = secondChat(session);
        UUID otherRoot = UUID.fromString(sendMessage(session, otherChat, randomKey(),
                UUID.randomUUID().toString(), "other-root").get("id").asText());

        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM information_schema.columns
                 WHERE table_schema = 'message' AND table_name = 'messages'
                   AND column_name = 'thread_root_id'
                """, Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_constraint
                 WHERE conrelid = 'message.messages'::regclass
                   AND conname IN ('ck_messages_thread_no_self',
                                   'ck_messages_e2ee_no_thread_root')
                """, Integer.class)).isEqualTo(2);
        assertThat(jdbc.queryForObject("""
                SELECT count(*) FROM pg_trigger
                 WHERE tgrelid = 'message.messages'::regclass
                   AND tgname = 'trg_messages_thread_root' AND NOT tgisinternal
                """, Integer.class)).isEqualTo(1);
        String parentIndex = jdbc.queryForObject("""
                SELECT indexdef FROM pg_indexes
                 WHERE schemaname = 'message' AND indexname = 'ix_messages_chat_thread_seq'
                """, String.class);
        assertThat(parentIndex).contains("(chat_id, thread_root_id, seq)");
        Integer partitionIndexes = jdbc.queryForObject("""
                SELECT count(*) FROM pg_indexes
                 WHERE schemaname = 'message' AND tablename LIKE 'messages\\_2%'
                   AND indexdef LIKE '%(chat_id, thread_root_id, seq)%'
                """, Integer.class);
        assertThat(partitionIndexes).isGreaterThanOrEqualTo(3);

        // Direct SQL bypassing the application: the trigger/check constraints are the
        // last line of defence and name the exact violation.
        assertThatThrownBy(() -> rawReply(session, chatId, 9001, UUID.randomUUID()))
                .isInstanceOf(DataAccessException.class)
                .hasStackTraceContaining("THREAD_ROOT_NOT_FOUND");
        assertThatThrownBy(() -> rawReply(session, chatId, 9002, replyId))
                .isInstanceOf(DataAccessException.class)
                .hasStackTraceContaining("THREAD_NESTING_UNSUPPORTED");
        assertThatThrownBy(() -> rawReply(session, chatId, 9003, otherRoot))
                .isInstanceOf(DataAccessException.class)
                .hasStackTraceContaining("THREAD_ROOT_OTHER_CHAT");

        migrator().update("UPDATE message.messages SET deleted_at = now() WHERE id = ?", rootId);
        assertThatThrownBy(() -> rawReply(session, chatId, 9004, rootId))
                .isInstanceOf(DataAccessException.class)
                .hasStackTraceContaining("THREAD_ROOT_DELETED");

        // E2EE rows cannot carry a thread root even via direct SQL.
        migrator().update("UPDATE message.messages SET deleted_at = NULL WHERE id = ?", rootId);
        assertThatThrownBy(() -> migrator().update("""
                INSERT INTO message.messages
                       (id, workspace_id, chat_id, seq, sender_id, sender_device_id, type,
                        crypto_scheme, thread_root_id)
                VALUES (?, ?, ?, 9005, ?, ?, 'TEXT', 'E2EE_PAIRWISE', ?)
                """, UUID.randomUUID(), session.workspace().id(), chatId,
                session.user().id(), session.device().id(), rootId))
                .isInstanceOf(DataAccessException.class)
                .hasStackTraceContaining("ck_messages_e2ee_no_thread_root");
    }

    @Test
    void threadSummariesAreTenantIsolatedUnderRls() throws Exception {
        SessionResponse alice = devSession();
        SessionResponse bob = devSession();
        UUID aliceRoot = UUID.fromString(sendMessage(alice, alice.chat().id(), randomKey(),
                UUID.randomUUID().toString(), "alice-root").get("id").asText());
        sendReply(alice, alice.chat().id(), aliceRoot, "alice-reply", 201);
        UUID bobRoot = UUID.fromString(sendMessage(bob, bob.chat().id(), randomKey(),
                UUID.randomUUID().toString(), "bob-root").get("id").asText());
        sendReply(bob, bob.chat().id(), bobRoot, "bob-reply", 201);

        assertThat(inTenant(alice.user().id(), alice.workspace().id(),
                () -> jdbc.queryForObject("""
                        SELECT count(*) FROM message.messages WHERE thread_root_id IS NOT NULL
                        """, Integer.class))).isEqualTo(1);
        assertThat(inTenant(alice.user().id(), alice.workspace().id(),
                () -> jdbc.queryForObject("""
                        SELECT count(*) FROM message.messages WHERE thread_root_id = ?
                        """, Integer.class, bobRoot))).isZero();

        Page alicePage = mainFeed(alice, alice.chat().id());
        assertThat(alicePage.byId(aliceRoot).get("thread_summary").get("reply_count").asInt())
                .isEqualTo(1);
        assertThat(alicePage.byId(aliceRoot).get("thread_summary").get("last_reply_excerpt")
                .asText()).isEqualTo("alice-reply");
        assertThat(mainFeed(bob, bob.chat().id()).byId(bobRoot).get("thread_summary")
                .get("reply_count").asInt()).isEqualTo(1);

        // A reply pointing at Bob's root cannot be written with Alice's tenant context.
        assertThatThrownBy(() -> inTenant(alice.user().id(), alice.workspace().id(),
                () -> jdbc.update("""
                        INSERT INTO message.messages
                               (id, workspace_id, chat_id, seq, sender_id, type, crypto_scheme,
                                body_ciphertext, thread_root_id)
                        VALUES (?, ?, ?, 9100, ?, 'TEXT', 'MANAGED', decode('00','hex'), ?)
                        """, UUID.randomUUID(), bob.workspace().id(), bob.chat().id(),
                        bob.user().id(), bobRoot)))
                .isInstanceOf(DataAccessException.class);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private record Page(JsonNode node) {
        JsonNode byId(UUID id) {
            for (JsonNode item : node.get("items")) {
                if (id.toString().equals(item.get("id").asText())) {
                    return item;
                }
            }
            throw new AssertionError("message " + id + " not found in page: " + node);
        }
    }

    private Page mainFeed(SessionResponse session, UUID chatId) throws Exception {
        return new Page(getMessages(session, chatId, null, null, null, null));
    }

    private JsonNode getMessages(SessionResponse session, UUID chatId, Long afterSeq,
                                 Long beforeSeq, Integer limit, UUID threadRootId)
            throws Exception {
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
        if (threadRootId != null) {
            request.param("thread_root_id", threadRootId.toString());
        }
        MvcResult result = mockMvc.perform(request).andExpect(status().isOk()).andReturn();
        return json(result);
    }

    private JsonNode sendReply(SessionResponse session, UUID chatId, UUID rootId, String text,
                               int expected) throws Exception {
        return sendReply(session, chatId, rootId, text, expected, UUID.randomUUID(),
                UUID.randomUUID().toString());
    }

    private JsonNode sendReply(SessionResponse session, UUID chatId, UUID rootId, String text,
                               int expected, UUID idempotencyKey, String clientMessageId)
            throws Exception {
        MvcResult result = postReply(session, chatId, rootId, text, idempotencyKey,
                clientMessageId);
        assertThat(result.getResponse().getStatus()).isEqualTo(expected);
        return json(result);
    }

    private MvcResult postReply(SessionResponse session, UUID chatId, UUID rootId, String text,
                                UUID idempotencyKey, String clientMessageId) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("client_message_id", clientMessageId);
        body.put("type", "TEXT");
        body.put("text", text);
        body.put("thread_root_id", rootId.toString());
        return mockMvc.perform(authed(post("/api/v1/chats/{chatId}/messages", chatId), session)
                        .header("Idempotency-Key", idempotencyKey.toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andReturn();
    }

    private void assertThreadError(SessionResponse session, UUID chatId, UUID rootId,
                                   int expectedStatus, String expectedCode) throws Exception {
        MvcResult result = postReply(session, chatId, rootId, "nope", UUID.randomUUID(),
                UUID.randomUUID().toString());
        assertThat(result.getResponse().getStatus()).isEqualTo(expectedStatus);
        JsonNode error = json(result);
        assertThat(error.get("code").asText()).isEqualTo(expectedCode);
        assertThat(error.get("details").get("field").asText()).isEqualTo("thread_root_id");
    }

    private void assertThreadListError(SessionResponse session, UUID chatId, UUID rootId,
                                       int expectedStatus, String expectedCode)
            throws Exception {
        MvcResult result = mockMvc.perform(authed(
                        get("/api/v1/chats/{chatId}/messages", chatId), session)
                        .param("thread_root_id", rootId.toString()))
                .andReturn();
        assertThat(result.getResponse().getStatus()).isEqualTo(expectedStatus);
        assertThat(json(result).get("code").asText()).isEqualTo(expectedCode);
    }

    private UUID secondChat(SessionResponse session) {
        UUID chatId = UUID.randomUUID();
        migrator().update("""
                INSERT INTO chat.chats (id, workspace_id, type, security_mode, name, created_by)
                VALUES (?, ?, 'GROUP', 'MANAGED', 'second', ?)
                """, chatId, session.workspace().id(), session.user().id());
        migrator().update("""
                INSERT INTO chat.chat_members (chat_id, workspace_id, user_id, role, status)
                VALUES (?, ?, ?, 'OWNER', 'ACTIVE')
                """, chatId, session.workspace().id(), session.user().id());
        migrator().update("INSERT INTO chat.chat_counters (chat_id, workspace_id) VALUES (?, ?)",
                chatId, session.workspace().id());
        return chatId;
    }

    private void rawReply(SessionResponse session, UUID chatId, long seq, UUID threadRootId) {
        migrator().update("""
                INSERT INTO message.messages
                       (id, workspace_id, chat_id, seq, sender_id, type, crypto_scheme,
                        body_ciphertext, thread_root_id)
                VALUES (?, ?, ?, ?, ?, 'TEXT', 'MANAGED', decode('00','hex'), ?)
                """, UUID.randomUUID(), session.workspace().id(), chatId, seq,
                session.user().id(), threadRootId);
    }

    private static List<Long> seqs(JsonNode page) {
        List<Long> result = new java.util.ArrayList<>();
        page.get("items").forEach(item -> result.add(item.get("seq").asLong()));
        return result;
    }

    private static String randomKey() {
        return UUID.randomUUID().toString();
    }
}
