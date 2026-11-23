package ru.krug.backend.bot.domain.repository;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import ru.krug.backend.bot.domain.model.BotEventDelivery;
import ru.krug.backend.bot.domain.model.BotEventTarget;

/**
 * Durable bot-event storage. Tenant methods run under the caller's RLS GUC; the delivery
 * worker activates the narrow {@code bot-event-relay} role for the cross-tenant batch.
 */
public interface BotEventRepository {

    /** Active bots installed and enabled in the chat, with their event/command config. */
    List<BotEventTarget> findTargets(UUID workspaceId, UUID chatId);

    /**
     * Appends a delivery. The unique {(bot_id, event_type, event_id)} key makes a replay a
     * silent no-op.
     *
     * @return {@code true} when a row was inserted
     */
    boolean enqueue(BotEventDelivery delivery);

    /** Newest deliveries first; the payload/secret are never projected. */
    List<BotEventDelivery> findRecent(UUID workspaceId, UUID botId, int limit);

    /** Pending rows whose backoff elapsed, locked with SKIP LOCKED for the worker. */
    List<BotEventDelivery> lockDue(Instant now, int batchSize);

    void markDelivered(UUID id, Instant now);

    void markFailed(UUID id, int attempts, Integer statusCode, String error, Instant now);

    void reschedule(UUID id, int attempts, Instant nextAttemptAt, Integer statusCode,
                    String error, Instant now);
}
