package ru.krug.backend.bot.application.usecase;

import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.bot.application.model.BotMessageEvent;
import ru.krug.backend.bot.application.port.BotEventPort;
import ru.krug.backend.bot.application.port.BotSecretCipherPort;
import ru.krug.backend.bot.application.service.BotEventEnvelope;
import ru.krug.backend.bot.domain.model.BotDeliveryStatus;
import ru.krug.backend.bot.domain.model.BotEventDelivery;
import ru.krug.backend.bot.domain.model.BotEventTarget;
import ru.krug.backend.bot.domain.model.BotEventType;
import ru.krug.backend.bot.domain.repository.BotEventRepository;
import ru.krug.backend.shared.application.port.ClockPort;

/**
 * Appends durable {@code message.created}/{@code app_mention} deliveries inside the message
 * transaction. No HTTP call happens here: the worker sends only after commit. Message replays
 * return before the insert and the unique (bot, type, event) key backstops a re-entry, so a
 * retried send never creates a duplicate webhook.
 *
 * <p>Definition of {@code app_mention}: the managed message text contains {@code @<bot name>}
 * (case-insensitive) OR the send used the server-validated {@code @all} mention flag. Bots
 * are not chat members, so the per-user mention ids cannot address them; this text/flag rule
 * is the documented Slack-like approximation. Bot-authored messages never fan out (loop
 * prevention).</p>
 */
@Service
public class BotEventDispatchService implements BotEventPort {

    private final BotEventRepository deliveries;
    private final BotEventEnvelope envelope;
    private final BotSecretCipherPort secretCipher;
    private final ClockPort clock;

    public BotEventDispatchService(BotEventRepository deliveries, BotEventEnvelope envelope,
                                   BotSecretCipherPort secretCipher, ClockPort clock) {
        this.deliveries = deliveries;
        this.envelope = envelope;
        this.secretCipher = secretCipher;
        this.clock = clock;
    }

    @Override
    @Transactional(propagation = Propagation.MANDATORY)
    public void onMessageCreated(BotMessageEvent event) {
        if (event == null || event.isBotAuthored()) {
            return;
        }
        List<BotEventTarget> targets = deliveries.findTargets(event.workspaceId(),
                event.chatId());
        if (targets.isEmpty()) {
            return;
        }
        Instant now = clock.now();
        for (BotEventTarget target : targets) {
            if (!target.webhookReady()) {
                continue;
            }
            if (target.subscribedTo(BotEventType.MESSAGE_CREATED)) {
                enqueue(target, BotEventType.MESSAGE_CREATED, event.messageId(), event, now);
            }
            if (target.subscribedTo(BotEventType.APP_MENTION) && mentions(target, event)) {
                enqueue(target, BotEventType.APP_MENTION, event.messageId(), event, now);
            }
        }
    }

    private void enqueue(BotEventTarget target, BotEventType type, UUID eventId,
                         BotMessageEvent event, Instant now) {
        UUID deliveryId = UUID.randomUUID();
        String json = envelope.messageEvent(type, event);
        byte[] payload = secretCipher.encryptPayload(json, deliveryId);
        deliveries.enqueue(new BotEventDelivery(deliveryId, event.workspaceId(),
                target.botId(), event.chatId(), type, eventId, payload,
                BotDeliveryStatus.PENDING, 0, now, null, null, now, now, null));
    }

    static boolean mentions(BotEventTarget target, BotMessageEvent event) {
        if (event.mentionAll()) {
            return true;
        }
        String text = event.text();
        if (text == null || text.isBlank() || target.name() == null
                || target.name().isBlank()) {
            return false;
        }
        return text.toLowerCase(Locale.ROOT)
                .contains("@" + target.name().toLowerCase(Locale.ROOT));
    }
}
