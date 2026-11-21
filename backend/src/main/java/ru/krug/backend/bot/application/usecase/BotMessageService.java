package ru.krug.backend.bot.application.usecase;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.bot.application.command.BotMessageCommand;
import ru.krug.backend.bot.application.model.BotChatContext;
import ru.krug.backend.bot.application.model.BotMessageResult;
import ru.krug.backend.bot.application.model.BotPrincipal;
import ru.krug.backend.bot.application.port.BotChatContextPort;
import ru.krug.backend.bot.domain.model.Bot;
import ru.krug.backend.bot.domain.model.BotScope;
import ru.krug.backend.bot.domain.repository.BotRepository;
import ru.krug.backend.chat.application.port.SeqAllocator;
import ru.krug.backend.message.application.event.MessageCreatedNotification;
import ru.krug.backend.message.application.model.MessageView;
import ru.krug.backend.message.application.service.MessageEventPayload;
import ru.krug.backend.message.domain.event.MessageCreatedEvent;
import ru.krug.backend.message.domain.model.Message;
import ru.krug.backend.message.domain.model.MessageBody;
import ru.krug.backend.message.domain.repository.MessageRepository;
import ru.krug.backend.ops.application.model.IdempotencyReservation;
import ru.krug.backend.ops.application.model.OutboxEvent;
import ru.krug.backend.ops.application.port.IdempotencyPort;
import ru.krug.backend.ops.application.port.OutboxPort;
import ru.krug.backend.ops.application.port.RateLimitPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.RequestCanonicalizer;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * {@code POST /bots/{botId}/messages}: the only bot write in the MVP.
 *
 * <p>Guarantees: the caller is the authenticated bot (never a user), the scope is
 * {@code chat.write}, the chat is MANAGED and the bot is installed+enabled there, the round
 * trip is idempotent by {@code Idempotency-Key}, and the row is created as a BOT sender with
 * no user/device identity. The body follows the normal managed message pipeline: per-chat
 * seq, encrypted body, outbox + post-commit realtime/notification fan-out.</p>
 */
@Service
public class BotMessageService {

    static final String IDEMPOTENCY_SCOPE = "bot.message";

    private final TenantContext tenantContext;
    private final BotRepository bots;
    private final BotChatContextPort chatContext;
    private final MessageRepository messages;
    private final SeqAllocator seqAllocator;
    private final IdempotencyPort idempotency;
    private final RateLimitPort rateLimit;
    private final OutboxPort outbox;
    private final ApplicationEventPublisher events;
    private final ClockPort clock;
    private final RequestCanonicalizer canonicalizer;

    public BotMessageService(TenantContext tenantContext, BotRepository bots,
                             BotChatContextPort chatContext, MessageRepository messages,
                             SeqAllocator seqAllocator, IdempotencyPort idempotency,
                             RateLimitPort rateLimit, OutboxPort outbox,
                             ApplicationEventPublisher events, ClockPort clock,
                             RequestCanonicalizer canonicalizer) {
        this.tenantContext = tenantContext;
        this.bots = bots;
        this.chatContext = chatContext;
        this.messages = messages;
        this.seqAllocator = seqAllocator;
        this.idempotency = idempotency;
        this.rateLimit = rateLimit;
        this.outbox = outbox;
        this.events = events;
        this.clock = clock;
        this.canonicalizer = canonicalizer;
    }

    @Transactional
    public BotMessageResult send(BotPrincipal principal, BotMessageCommand command) {
        if (command.idempotencyKey() == null) {
            throw DomainException.badRequest("Idempotency-Key is required",
                    Map.of("field", "Idempotency-Key"));
        }
        if (command.chatId() == null) {
            throw DomainException.badRequest("chat_id is required",
                    Map.of("field", "chat_id"));
        }
        Principal actor = new Principal(principal.botId(), null, principal.workspaceId(),
                principal.requestId());
        tenantContext.activate(actor);

        Bot bot = bots.findById(principal.workspaceId(), principal.botId())
                .orElseThrow(() -> DomainException.unauthorized(ErrorCode.UNAUTHENTICATED,
                        "Invalid bot token", Map.of()));
        if (!bot.isActive()) {
            throw DomainException.forbidden(ErrorCode.BOT_DISABLED, "Bot is disabled",
                    Map.of("bot_id", bot.id().toString()));
        }
        if (!bot.hasScope(BotScope.CHAT_WRITE)) {
            throw DomainException.forbidden(ErrorCode.BOT_SCOPE_FORBIDDEN,
                    "The bot token does not grant chat.write",
                    Map.of("required_scope", BotScope.CHAT_WRITE.wire()));
        }

        BotChatContext context = chatContext.find(bot.workspaceId(), command.chatId(), bot.id())
                .orElseThrow(() -> DomainException.notFound("Chat not found"));
        if ("E2EE".equals(context.securityMode())) {
            throw DomainException.unprocessable(ErrorCode.BOT_E2EE_UNSUPPORTED,
                    "Bots cannot post to an E2EE chat", Map.of("chat_id",
                            command.chatId().toString()));
        }
        if (!context.installed() || !context.enabled()) {
            throw DomainException.forbidden(ErrorCode.BOT_NOT_INSTALLED,
                    "The bot is not installed and enabled in this chat",
                    Map.of("chat_id", command.chatId().toString(),
                            "bot_id", bot.id().toString()));
        }

        // Validate before idempotency so an invalid body never reserves a key.
        MessageBody body = new MessageBody(command.text());
        byte[] requestHash = requestHash(bot.id(), command);

        IdempotencyReservation reservation = idempotency.reserve(actor,
                IDEMPOTENCY_SCOPE, command.idempotencyKey(), requestHash);
        if (reservation.replay()) {
            return replay(bot, reservation.resourceId());
        }

        // A real send consumes quota; a replay above does no work and is never limited. A
        // rejection rolls back the reservation with the rest of the transaction.
        rateLimit.checkBotSend(bot.id(), command.chatId());

        Instant now = clock.now();
        long seq = seqAllocator.nextSeq(bot.workspaceId(), command.chatId());
        UUID messageId = UUID.randomUUID();
        Message message = Message.createBotText(messageId, bot.workspaceId(), command.chatId(),
                seq, bot.id(), bot.name(), body, now);
        messages.save(message);

        MessageView view = MessageView.from(message);
        MessageCreatedEvent event = new MessageCreatedEvent(messageId, bot.workspaceId(),
                command.chatId(), seq, null, now,
                body.value().getBytes(StandardCharsets.UTF_8).length);
        outbox.append(new OutboxEvent(bot.workspaceId(), "message", messageId,
                "message.created", 1, command.chatId().toString(),
                MessageEventPayload.of(event, view), now));
        idempotency.complete(actor, IDEMPOTENCY_SCOPE, command.idempotencyKey(), requestHash,
                201, messageId);
        events.publishEvent(new MessageCreatedNotification(bot.workspaceId(), view));
        return new BotMessageResult(view, false);
    }

    private BotMessageResult replay(Bot bot, UUID messageId) {
        if (messageId == null) {
            throw DomainException.internal();
        }
        Message message = messages.findById(bot.workspaceId(), messageId)
                .filter(Message::isBotMessage)
                .filter(existing -> bot.id().equals(existing.botId()))
                .orElseThrow(DomainException::internal);
        return new BotMessageResult(MessageView.from(message), true);
    }

    private byte[] requestHash(UUID botId, BotMessageCommand command) {
        Map<String, Object> canonical = new LinkedHashMap<>();
        canonical.put("chat_id", command.chatId().toString());
        canonical.put("text", command.text());
        return canonicalizer.sha256("POST\n/api/v1/bots/" + botId + "/messages\n"
                + canonicalizer.canonicalize(canonical));
    }
}
