package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.message.application.command.SendMessageCommand;
import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.support.IntegrationTestBase;

@ActiveProfiles("test")
class IdempotencyIT extends IntegrationTestBase {

    @Test
    void sameKeyAndBodyReplaysTheOriginalResponse() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        String key = UUID.randomUUID().toString();
        String clientId = UUID.randomUUID().toString();

        MvcResult first = postMessage(session, chatId, key, clientId, "idempotent");
        assertThat(first.getResponse().getStatus()).isEqualTo(201);
        assertThat(first.getResponse().getHeader("Idempotent-Replay")).isNull();
        JsonNode firstBody = json(first);

        MvcResult second = postMessage(session, chatId, key, clientId, "idempotent");
        assertThat(second.getResponse().getStatus()).isEqualTo(201);
        assertThat(second.getResponse().getHeader("Idempotent-Replay")).isEqualTo("true");
        JsonNode secondBody = json(second);

        assertThat(secondBody.get("id").asText()).isEqualTo(firstBody.get("id").asText());
        assertThat(secondBody.get("seq").asLong()).isEqualTo(firstBody.get("seq").asLong());
        assertThat(secondBody.get("text").asText()).isEqualTo("idempotent");
        assertThat(messageCount(chatId)).isEqualTo(1);
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM ops.outbox WHERE partition_key = ?", Integer.class,
                chatId.toString())).isEqualTo(1);
    }

    @Test
    void sameKeyWithDifferentBodyIs409Reused() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        String key = UUID.randomUUID().toString();
        String clientId = UUID.randomUUID().toString();

        postMessage(session, chatId, key, clientId, "original");

        MvcResult conflict = postMessage(session, chatId, key, clientId, "different");
        assertThat(conflict.getResponse().getStatus()).isEqualTo(409);
        JsonNode error = json(conflict);
        assertThat(error.get("code").asText()).isEqualTo("IDEMPOTENCY_KEY_REUSED");
        assertThat(error.get("details").get("original_request_hash").asText()).isNotBlank();
        assertThat(messageCount(chatId)).isEqualTo(1);
    }

    @Test
    void duplicateClientMessageIdWithSameBodyReturnsExistingMessage() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        String clientId = UUID.randomUUID().toString();

        MvcResult first = postMessage(session, chatId, UUID.randomUUID().toString(), clientId, "same");
        MvcResult second = postMessage(session, chatId, UUID.randomUUID().toString(), clientId, "same");

        assertThat(first.getResponse().getStatus()).isEqualTo(201);
        assertThat(second.getResponse().getStatus()).isEqualTo(201);
        assertThat(second.getResponse().getHeader("Idempotent-Replay")).isEqualTo("true");
        assertThat(json(second).get("id").asText()).isEqualTo(json(first).get("id").asText());
        assertThat(messageCount(chatId)).isEqualTo(1);
    }

    @Test
    void duplicateClientMessageIdWithDifferentBodyIs409Conflict() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        String clientId = UUID.randomUUID().toString();

        postMessage(session, chatId, UUID.randomUUID().toString(), clientId, "first");
        MvcResult conflict = postMessage(session, chatId, UUID.randomUUID().toString(), clientId, "second");

        assertThat(conflict.getResponse().getStatus()).isEqualTo(409);
        assertThat(json(conflict).get("code").asText()).isEqualTo("CLIENT_MESSAGE_ID_CONFLICT");
        assertThat(messageCount(chatId)).isEqualTo(1);

        MvcResult retry = postMessage(session, chatId, UUID.randomUUID().toString(), clientId, "second");
        assertThat(retry.getResponse().getStatus()).isEqualTo(409);
        assertThat(json(retry).get("code").asText()).isEqualTo("CLIENT_MESSAGE_ID_CONFLICT");
    }

    @Test
    void concurrentDuplicateOfAnInFlightKeyReturns409InProgress() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        String key = UUID.randomUUID().toString();
        UUID clientId = UUID.randomUUID();
        String text = "still-processing";

        Map<String, Object> canonical = new LinkedHashMap<>();
        canonical.put("client_message_id", clientId);
        canonical.put("type", "TEXT");
        canonical.put("text", text);
        canonical.put("reply_to_id", null);
        canonical.put("attachment_ids", List.of());
        byte[] hash = canonicalizer.sha256("POST\n/api/v1/chats/" + chatId + "/messages\n"
                + canonicalizer.canonicalize(canonical));
        migrator().update("""
                INSERT INTO ops.idempotency_keys
                       (user_id, scope, key, request_hash, status, created_at, expires_at)
                VALUES (?, ?, ?, ?, NULL, now(), now() + interval '24 hours')
                """, session.user().id(), SendMessageCommand.IDEMPOTENCY_SCOPE, key, hash);

        MvcResult result = postMessage(session, chatId, key, clientId.toString(), text);
        assertThat(result.getResponse().getStatus()).isEqualTo(409);
        assertThat(json(result).get("code").asText()).isEqualTo("IDEMPOTENCY_IN_PROGRESS");
        assertThat(result.getResponse().getHeader("Retry-After")).isEqualTo("1");
        assertThat(messageCount(chatId)).isZero();
    }

    @Test
    void twoConcurrentRequestsWithSameKeyCreateOneMessage() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        String key = UUID.randomUUID().toString();
        String clientId = UUID.randomUUID().toString();

        List<MvcResult> results = runConcurrently(() -> postMessage(session, chatId, key, clientId, "race"));

        assertThat(results).hasSize(2);
        long created = results.stream()
                .filter(r -> r.getResponse().getStatus() == 201
                        && r.getResponse().getHeader("Idempotent-Replay") == null)
                .count();
        assertThat(created).isEqualTo(1);
        for (MvcResult result : results) {
            if (result.getResponse().getStatus() == 409) {
                assertThat(result.getResponse().getContentAsString()).contains("IDEMPOTENCY_IN_PROGRESS");
                assertThat(result.getResponse().getHeader("Retry-After")).isEqualTo("1");
            } else {
                assertThat(result.getResponse().getStatus()).isEqualTo(201);
            }
        }
        assertThat(messageCount(chatId)).isEqualTo(1);
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM ops.outbox WHERE partition_key = ?", Integer.class,
                chatId.toString())).isEqualTo(1);
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM ops.idempotency_keys
                 WHERE user_id = ? AND key = ? AND status = 201
                """, Integer.class, session.user().id(), key)).isEqualTo(1);

        // The contract's Retry-After retry must converge on the original message, never a
        // duplicate. Even if the loser already replayed, this is still a replay.
        MvcResult winner = results.stream()
                .filter(r -> r.getResponse().getStatus() == 201)
                .findFirst().orElseThrow();
        MvcResult retry = postMessage(session, chatId, key, clientId, "race");
        assertThat(retry.getResponse().getStatus()).isEqualTo(201);
        assertThat(retry.getResponse().getHeader("Idempotent-Replay")).isEqualTo("true");
        assertThat(json(retry).get("id").asText()).isEqualTo(json(winner).get("id").asText());
        assertThat(messageCount(chatId)).isEqualTo(1);
    }

    @Test
    void staleInProgressReservationIsRecoveredOnRetry() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        String key = UUID.randomUUID().toString();
        UUID clientId = UUID.randomUUID();
        String text = "recover-me";

        Map<String, Object> canonical = new LinkedHashMap<>();
        canonical.put("client_message_id", clientId);
        canonical.put("type", "TEXT");
        canonical.put("text", text);
        canonical.put("reply_to_id", null);
        canonical.put("attachment_ids", List.of());
        byte[] hash = canonicalizer.sha256("POST\n/api/v1/chats/" + chatId + "/messages\n"
                + canonicalizer.canonicalize(canonical));
        // Simulates a pre-B-02 crash: a committed in-progress row older than the recovery
        // timeout (1h default). It must be taken over, not returned as a permanent 409.
        migrator().update("""
                INSERT INTO ops.idempotency_keys
                       (user_id, scope, key, request_hash, status, created_at, expires_at)
                VALUES (?, ?, ?, ?, NULL, now() - interval '2 hours',
                        now() + interval '22 hours')
                """, session.user().id(), SendMessageCommand.IDEMPOTENCY_SCOPE, key, hash);

        MvcResult result = postMessage(session, chatId, key, clientId.toString(), text);
        assertThat(result.getResponse().getStatus()).isEqualTo(201);
        assertThat(result.getResponse().getHeader("Idempotent-Replay")).isNull();
        assertThat(messageCount(chatId)).isEqualTo(1);
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM ops.idempotency_keys
                 WHERE user_id = ? AND key = ? AND status = 201
                """, Integer.class, session.user().id(), key)).isEqualTo(1);

        MvcResult replay = postMessage(session, chatId, key, clientId.toString(), text);
        assertThat(replay.getResponse().getStatus()).isEqualTo(201);
        assertThat(replay.getResponse().getHeader("Idempotent-Replay")).isEqualTo("true");
        assertThat(json(replay).get("id").asText())
                .isEqualTo(json(result).get("id").asText());
    }

    @Test
    void twoConcurrentRequestsWithSameClientMessageIdCreateOneMessage() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        String clientId = UUID.randomUUID().toString();

        List<MvcResult> results = runConcurrently(() ->
                postMessage(session, chatId, UUID.randomUUID().toString(), clientId, "race-client-id"));

        assertThat(results).hasSize(2);
        assertThat(results).allMatch(result -> result.getResponse().getStatus() == 201);
        assertThat(messageCount(chatId)).isEqualTo(1);
        long replayed = results.stream()
                .filter(result -> "true".equals(result.getResponse().getHeader("Idempotent-Replay")))
                .count();
        assertThat(replayed).isGreaterThanOrEqualTo(1);
    }

    private MvcResult postMessage(SessionResponse session, UUID chatId, String key, String clientId,
                                  String text) throws Exception {
        return mockMvc.perform(authed(post("/api/v1/chats/{chatId}/messages", chatId), session)
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(messageBody(clientId, text, null)))
                .andReturn();
    }

    private List<MvcResult> runConcurrently(Callable<MvcResult> action) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch start = new CountDownLatch(1);
        try {
            List<Future<MvcResult>> futures = new ArrayList<>();
            for (int i = 0; i < 2; i++) {
                futures.add(pool.submit(() -> {
                    start.await(10, TimeUnit.SECONDS);
                    return action.call();
                }));
            }
            start.countDown();
            List<MvcResult> results = new ArrayList<>();
            for (Future<MvcResult> future : futures) {
                results.add(future.get(30, TimeUnit.SECONDS));
            }
            return results;
        } finally {
            pool.shutdownNow();
        }
    }
}
