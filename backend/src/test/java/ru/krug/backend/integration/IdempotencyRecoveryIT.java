package ru.krug.backend.integration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.servlet.MvcResult;

import ru.krug.backend.ops.api.dto.SessionResponse;
import ru.krug.backend.ops.application.usecase.OutboxAppenderService;
import ru.krug.backend.support.IntegrationTestBase;

/**
 * B-02: a failure after the idempotency reservation must roll the whole send back. The
 * retry must be a normal create (no permanent IDEMPOTENCY_IN_PROGRESS), and the following
 * replay must return the same message.
 */
@ActiveProfiles("test")
class IdempotencyRecoveryIT extends IntegrationTestBase {

    @MockitoSpyBean
    private OutboxAppenderService outboxAppender;

    @Test
    void failureAfterReservationLeavesNoInProgressAndRetryCreatesOneMessage() throws Exception {
        SessionResponse session = devSession();
        UUID chatId = session.chat().id();
        String key = UUID.randomUUID().toString();
        String clientId = UUID.randomUUID().toString();

        AtomicInteger calls = new AtomicInteger();
        doAnswer(invocation -> {
            if (calls.getAndIncrement() == 0) {
                throw new IllegalStateException("simulated outbox failure after reservation");
            }
            return invocation.callRealMethod();
        }).when(outboxAppender).append(any());

        MvcResult failed = send(session, chatId, key, clientId, "recoverable");
        assertThat(failed.getResponse().getStatus()).isEqualTo(500);
        assertThat(messageCount(chatId)).isZero();
        assertThat(migrator().queryForObject("""
                SELECT count(*) FROM ops.idempotency_keys WHERE user_id = ? AND key = ?
                """, Integer.class, session.user().id(), key)).isZero();
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM ops.outbox WHERE partition_key = ?", Integer.class,
                chatId.toString())).isZero();

        MvcResult retried = send(session, chatId, key, clientId, "recoverable");
        assertThat(retried.getResponse().getStatus()).isEqualTo(201);
        assertThat(retried.getResponse().getHeader("Idempotent-Replay")).isNull();
        assertThat(messageCount(chatId)).isEqualTo(1);

        MvcResult replay = send(session, chatId, key, clientId, "recoverable");
        assertThat(replay.getResponse().getStatus()).isEqualTo(201);
        assertThat(replay.getResponse().getHeader("Idempotent-Replay")).isEqualTo("true");
        assertThat(json(replay).get("id").asText())
                .isEqualTo(json(retried).get("id").asText());
        assertThat(messageCount(chatId)).isEqualTo(1);
        assertThat(migrator().queryForObject(
                "SELECT count(*) FROM ops.outbox WHERE partition_key = ?", Integer.class,
                chatId.toString())).isEqualTo(1);
    }

    private MvcResult send(SessionResponse session, UUID chatId, String key, String clientId,
                           String text) throws Exception {
        return mockMvc.perform(authed(post("/api/v1/chats/{chatId}/messages", chatId), session)
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(messageBody(clientId, text, null)))
                .andReturn();
    }
}
