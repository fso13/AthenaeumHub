package ru.krug.backend.bot.application.usecase;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.bot.application.port.BotSecretCipherPort;
import ru.krug.backend.bot.application.service.BotEventEnvelope;
import ru.krug.backend.bot.domain.model.Bot;
import ru.krug.backend.bot.domain.model.BotDeliveryStatus;
import ru.krug.backend.bot.domain.model.BotEventDelivery;
import ru.krug.backend.bot.domain.model.BotEventType;
import ru.krug.backend.bot.domain.repository.BotEventRepository;
import ru.krug.backend.bot.domain.repository.BotRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * {@code POST /workspaces/{workspaceId}/bots/{botId}/test-event} (OWNER/ADMIN): queues a
 * signed {@code test} ping. The ping proves URL/secret/SSRF/transport behaviour and is not
 * subject to the event subscription switch.
 */
@Service
public class TestBotEventService {

    private final BotAccessGuard access;
    private final BotRepository bots;
    private final BotEventRepository deliveries;
    private final BotEventEnvelope envelope;
    private final BotSecretCipherPort secretCipher;
    private final ClockPort clock;

    public TestBotEventService(BotAccessGuard access, BotRepository bots,
                               BotEventRepository deliveries, BotEventEnvelope envelope,
                               BotSecretCipherPort secretCipher, ClockPort clock) {
        this.access = access;
        this.bots = bots;
        this.deliveries = deliveries;
        this.envelope = envelope;
        this.secretCipher = secretCipher;
        this.clock = clock;
    }

    @Transactional
    public UUID queue(Principal principal, UUID workspaceId, UUID botId) {
        access.requireManager(principal, workspaceId);
        Bot bot = bots.findByIdForUpdate(workspaceId, botId)
                .orElseThrow(() -> BotErrors.notFound(workspaceId, botId));
        if (!bot.isActive() || bot.eventsUrl() == null || !bot.hasSigningSecret()) {
            throw DomainException.unprocessable(ErrorCode.BOT_EVENTS_NOT_CONFIGURED,
                    "Configure an events_url and a signing secret first",
                    Map.of("bot_id", botId.toString()));
        }
        Instant now = clock.now();
        UUID eventId = UUID.randomUUID();
        UUID deliveryId = UUID.randomUUID();
        String json = envelope.test(eventId, workspaceId, botId, now);
        byte[] payload = secretCipher.encryptPayload(json, deliveryId);
        deliveries.enqueue(new BotEventDelivery(deliveryId, workspaceId, botId, null,
                BotEventType.TEST, eventId, payload, BotDeliveryStatus.PENDING, 0, now,
                null, null, now, now, null));
        return deliveryId;
    }
}
