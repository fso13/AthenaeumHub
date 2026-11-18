package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.ops.application.usecase.OutboxRelayService;
import ru.krug.backend.support.IntegrationTestBase;

// The relay scheduler is disabled for this context: otherwise it can publish the row
// between the message insert and the explicit publishPending() call (timing flake).
@SpringBootTest(properties = "krug.outbox.relay.enabled=false")
@AutoConfigureMockMvc
@ActiveProfiles("test")
class OutboxIT extends IntegrationTestBase {

    @Autowired
    private OutboxRelayService outboxRelayService;

    @Test
    void writesMessageCreatedOutboxRowInTheSameTransaction() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        String phrase = "outbox-secret-phrase";
        String key = UUID.randomUUID().toString();
        String clientId = UUID.randomUUID().toString();

        MvcResult sent = mockMvc.perform(authed(post("/api/v1/chats/{chatId}/messages", chatId), session)
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(messageBody(clientId, phrase, null)))
                .andExpect(status().isCreated())
                .andReturn();
        UUID messageId = UUID.fromString(json(sent).get("id").asText());

        Map<String, Object> row = migrator().queryForMap("""
                SELECT event_type, payload::text AS payload, published_at
                  FROM ops.outbox WHERE aggregate_id = ?
                """, messageId);
        assertThat(row.get("event_type")).isEqualTo("message.created");
        String payload = (String) row.get("payload");
        assertThat(payload).contains("message_id", "chat_id", "seq", "sender_id", "size_bytes");
        assertThat(payload).doesNotContain(phrase);
        assertThat(payload).doesNotContain("\"text\"");
        assertThat(row.get("published_at")).isNull();

        byte[] ciphertext = migrator().queryForObject(
                "SELECT body_ciphertext FROM message.messages WHERE id = ?", byte[].class,
                messageId);
        assertThat(ciphertext).isNotNull();
        assertThat(new String(ciphertext, StandardCharsets.UTF_8)).doesNotContain(phrase);

        String meta = migrator().queryForObject(
                "SELECT content_meta::text FROM message.messages WHERE id = ?", String.class,
                messageId);
        assertThat(meta).doesNotContain(phrase);

        // A scheduler in another cached Keycloak-profile context shares this database and
        // may publish the row first. What matters is that the row ends up published, not
        // which component won the race (the historical timing flake of this suite).
        outboxRelayService.publishPending();
        java.sql.Timestamp publishedAt = migrator().queryForObject(
                "SELECT published_at FROM ops.outbox WHERE aggregate_id = ?",
                java.sql.Timestamp.class, messageId);
        assertThat(publishedAt).isNotNull();
        assertThat(publishedAt.toInstant()).isBefore(Instant.now().plusSeconds(5));

        // Idempotent replay must not append a second event or a second message.
        mockMvc.perform(authed(post("/api/v1/chats/{chatId}/messages", chatId), session)
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(messageBody(clientId, phrase, null)))
                .andExpect(status().isCreated());
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM ops.outbox WHERE partition_key = ?", Integer.class,
                chatId.toString())).isEqualTo(1);
    }

    @Test
    void failedSendDoesNotLeaveOutboxRow() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();

        int before = migrator().queryForObject(
                "SELECT count(*) FROM ops.outbox WHERE partition_key = ?", Integer.class,
                chatId.toString());

        mockMvc.perform(authed(post("/api/v1/chats/{chatId}/messages", chatId), session)
                        .header("Idempotency-Key", UUID.randomUUID().toString())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(messageBody(UUID.randomUUID().toString(), "bad reply",
                                UUID.randomUUID())))
                .andExpect(status().isUnprocessableEntity());

        int after = migrator().queryForObject(
                "SELECT count(*) FROM ops.outbox WHERE partition_key = ?", Integer.class,
                chatId.toString());
        assertThat(after).isEqualTo(before);
        assertThat(messageCount(chatId)).isZero();
    }

    @Test
    void seqGapsInTheAllocatorAreAllowedAndNotReused() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();

        JsonNode first = sendMessage(session, chatId, UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), "one");
        assertThat(first.get("seq").asLong()).isEqualTo(1);

        // Simulate a gap (e.g. an aborted allocation): seq 2 and 3 are never inserted.
        migrator().update("UPDATE chat.chat_counters SET next_seq = next_seq + 2 WHERE chat_id = ?",
                chatId);

        JsonNode next = sendMessage(session, chatId, UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), "two");
        assertThat(next.get("seq").asLong()).isEqualTo(4);
        assertThat(messageCount(chatId)).isEqualTo(2);

        var seqs = migrator().queryForList(
                "SELECT seq FROM message.messages WHERE chat_id = ? ORDER BY seq", Long.class, chatId);
        assertThat(seqs).containsExactly(1L, 4L);
        assertThat(seqs).doesNotHaveDuplicates();
    }

    @Test
    void tenantContextCannotReadForeignOutboxRowsAndRelayStillPublishes() throws Exception {
        SessionResponse a = devSession();
        SessionResponse b = devSession();
        sendMessageResult(a, a.chat().id(), UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), "tenant-a-only");
        sendMessageResult(b, b.chat().id(), UUID.randomUUID().toString(),
                UUID.randomUUID().toString(), "tenant-b-only");

        assertThat(inTenant(a.user().id(), a.workspace().id(),
                () -> jdbc.queryForObject(
                        "SELECT count(*) FROM ops.outbox WHERE workspace_id = ?",
                        Integer.class, b.workspace().id()))).isZero();
        assertThat(inTenant(a.user().id(), a.workspace().id(),
                () -> jdbc.queryForObject(
                        "SELECT count(*) FROM ops.outbox WHERE workspace_id <> ?",
                        Integer.class, a.workspace().id()))).isZero();

        outboxRelayService.publishPending();
        assertThat(migrator().queryForObject(
                "SELECT published_at FROM ops.outbox WHERE partition_key = ?",
                java.sql.Timestamp.class, b.chat().id().toString())).isNotNull();

        // Publishing is a worker-only operation; tenant A still cannot see B's row.
        assertThat(inTenant(a.user().id(), a.workspace().id(),
                () -> jdbc.queryForObject(
                        "SELECT count(*) FROM ops.outbox WHERE workspace_id = ?",
                        Integer.class, b.workspace().id()))).isZero();
    }

    private MvcResult sendMessageResult(SessionResponse session, UUID chatId, String key,
                                        String clientId, String text) throws Exception {
        return mockMvc.perform(authed(post("/api/v1/chats/{chatId}/messages", chatId), session)
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(messageBody(clientId, text, null)))
                .andExpect(status().isCreated())
                .andReturn();
    }
}
