package ru.krug.backend.bot.application.usecase;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.bot.application.port.BotDeliveryException;
import ru.krug.backend.bot.application.port.BotEventTransport;
import ru.krug.backend.bot.application.port.BotEventSettings;
import ru.krug.backend.bot.application.port.BotSecretCipherPort;
import ru.krug.backend.bot.application.service.BotSignatures;
import ru.krug.backend.bot.application.service.BotWebhookUrlGuard;
import ru.krug.backend.bot.domain.model.Bot;
import ru.krug.backend.bot.domain.model.BotEventDelivery;
import ru.krug.backend.bot.domain.repository.BotEventRepository;
import ru.krug.backend.bot.domain.repository.BotRepository;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.WorkerContext;

/**
 * Sends due bot webhooks. The worker activates the narrow {@code bot-event-relay} role and
 * locks a batch with {@code FOR UPDATE SKIP LOCKED}; no tenant GUC is used for the batch.
 *
 * <p>Every row is signed with HMAC-SHA256 over {@code v1:<timestamp>:<body>} in
 * {@code X-Sova-Signature}; {@code X-Sova-Timestamp} carries the epoch-second send time. The
 * receiver must verify both and reject stale timestamps. Failures are retried with
 * exponential backoff up to the configured cap; permanent failures (4xx except 408/429,
 * redirects, private/unresolvable targets, oversized bodies) are not retried. The log never
 * contains the URL, body, secret or message text.</p>
 */
@Service
public class BotEventDeliveryService {

    private final WorkerContext workerContext;
    private final BotEventRepository deliveries;
    private final BotRepository bots;
    private final BotSecretCipherPort secretCipher;
    private final BotWebhookUrlGuard urlGuard;
    private final BotEventTransport transport;
    private final BotEventSettings properties;
    private final ClockPort clock;

    public BotEventDeliveryService(WorkerContext workerContext, BotEventRepository deliveries,
                                   BotRepository bots, BotSecretCipherPort secretCipher,
                                   BotWebhookUrlGuard urlGuard, BotEventTransport transport,
                                   BotEventSettings properties, ClockPort clock) {
        this.workerContext = workerContext;
        this.deliveries = deliveries;
        this.bots = bots;
        this.secretCipher = secretCipher;
        this.urlGuard = urlGuard;
        this.transport = transport;
        this.properties = properties;
        this.clock = clock;
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public int deliverDue() {
        workerContext.activate(WorkerContext.WorkerRole.BOT_EVENT_RELAY);
        Instant now = clock.now();
        List<BotEventDelivery> due = deliveries.lockDue(now, properties.batchSize());
        for (BotEventDelivery delivery : due) {
            deliverOne(delivery, now);
        }
        return due.size();
    }

    private void deliverOne(BotEventDelivery delivery, Instant now) {
        Bot bot = bots.findById(delivery.workspaceId(), delivery.botId()).orElse(null);
        if (bot == null || !bot.isActive() || bot.eventsUrl() == null
                || !bot.hasSigningSecret() || !bot.eventsEnabled()) {
            deliveries.markFailed(delivery.id(), delivery.attemptCount() + 1, null,
                    "bot_unavailable", now);
            return;
        }

        String secret;
        String payload;
        try {
            secret = secretCipher.decryptSecret(bot.signingSecretEncrypted(), bot.id());
            payload = secretCipher.decryptPayload(delivery.payloadEncrypted(), delivery.id());
        } catch (RuntimeException ex) {
            deliveries.markFailed(delivery.id(), delivery.attemptCount() + 1, null,
                    "payload_unreadable", now);
            return;
        }
        if (payload == null) {
            deliveries.markFailed(delivery.id(), delivery.attemptCount() + 1, null,
                    "payload_missing", now);
            return;
        }
        byte[] body = payload.getBytes(StandardCharsets.UTF_8);
        if (body.length > properties.maxPayloadBytes()) {
            deliveries.markFailed(delivery.id(), delivery.attemptCount() + 1, null,
                    "payload_too_large", now);
            return;
        }

        URI uri;
        try {
            uri = urlGuard.validate(bot.eventsUrl());
        } catch (BotDeliveryException ex) {
            deliveries.markFailed(delivery.id(), delivery.attemptCount() + 1, null,
                    ex.reason(), now);
            return;
        }

        long timestamp = clock.now().getEpochSecond();
        String signature = BotSignatures.sign(secret, timestamp, body);
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Content-Type", "application/json");
        headers.put("User-Agent", "SovaBotEvents/1.0");
        headers.put("X-Sova-Signature", signature);
        headers.put("X-Sova-Timestamp", Long.toString(timestamp));
        headers.put("X-Sova-Event-Type", delivery.eventType().wire());
        headers.put("X-Sova-Event-Id", delivery.eventId().toString());
        headers.put("X-Sova-Delivery-Id", delivery.id().toString());

        BotEventTransport.BotEventTransportResult result =
                transport.send(uri, headers, body);
        if (result.success()) {
            deliveries.markDelivered(delivery.id(), clock.now());
            return;
        }

        int attempts = delivery.attemptCount() + 1;
        Integer statusCode = result.statusCode() > 0 ? result.statusCode() : null;
        if (!result.retryable() || attempts >= properties.maxAttempts()) {
            deliveries.markFailed(delivery.id(), attempts, statusCode, safeReason(
                    result.error()), clock.now());
            return;
        }
        Instant next = clock.now().plus(backoff(attempts));
        deliveries.reschedule(delivery.id(), attempts, next, statusCode,
                safeReason(result.error()), clock.now());
    }

    Duration backoff(int attempts) {
        Duration delay = properties.retryBaseDelay();
        for (int index = 1; index < attempts; index++) {
            delay = delay.multipliedBy(2);
            if (delay.compareTo(properties.retryMaxDelay()) >= 0) {
                return properties.retryMaxDelay();
            }
        }
        return delay.compareTo(properties.retryMaxDelay()) > 0
                ? properties.retryMaxDelay() : delay;
    }

    private static String safeReason(String reason) {
        if (reason == null || reason.isBlank()) {
            return "delivery_failed";
        }
        String trimmed = reason.strip();
        return trimmed.length() <= 120 ? trimmed : trimmed.substring(0, 120);
    }
}
