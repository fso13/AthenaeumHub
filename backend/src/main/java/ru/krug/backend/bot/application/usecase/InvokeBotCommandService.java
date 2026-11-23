package ru.krug.backend.bot.application.usecase;

import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.bot.application.model.BotChatAccess;
import ru.krug.backend.bot.application.port.BotChatAccessPort;
import ru.krug.backend.bot.application.port.BotEventSettings;
import ru.krug.backend.bot.application.port.BotSecretCipherPort;
import ru.krug.backend.bot.application.service.BotEventEnvelope;
import ru.krug.backend.bot.application.service.BotResponseTokens;
import ru.krug.backend.bot.domain.model.BotCommand;
import ru.krug.backend.bot.domain.model.BotCommandToken;
import ru.krug.backend.bot.domain.model.BotDeliveryStatus;
import ru.krug.backend.bot.domain.model.BotEventDelivery;
import ru.krug.backend.bot.domain.model.BotEventTarget;
import ru.krug.backend.bot.domain.model.BotEventType;
import ru.krug.backend.bot.domain.repository.BotCommandTokenRepository;
import ru.krug.backend.bot.domain.repository.BotEventRepository;
import ru.krug.backend.ops.application.port.RateLimitPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * {@code POST /chats/{chatId}/commands} from an active chat member.
 *
 * <p>The command is resolved against the bots installed and enabled in this MANAGED chat.
 * Exactly one bot must own the command (two owners is an explicit 409, never a guess). The
 * invocation creates a one-time response capability and a signed {@code slash_command}
 * delivery — it does NOT write a chat message. The webhook payload carries the capability in
 * {@code response_url}; only its SHA-256 hash is stored.</p>
 */
@Service
public class InvokeBotCommandService {

    static final String ACTION = "bot.command.invoked";
    public static final int ARGS_MAX_LENGTH = 2000;

    private final BotChatAccessPort chatAccess;
    private final BotEventRepository deliveries;
    private final BotCommandTokenRepository tokens;
    private final BotEventEnvelope envelope;
    private final BotSecretCipherPort secretCipher;
    private final BotEventSettings properties;
    private final RateLimitPort rateLimit;
    private final AuditPort audit;
    private final ClockPort clock;

    public InvokeBotCommandService(BotChatAccessPort chatAccess, BotEventRepository deliveries,
                                   BotCommandTokenRepository tokens,
                                   BotEventEnvelope envelope,
                                   BotSecretCipherPort secretCipher,
                                   BotEventSettings properties, RateLimitPort rateLimit,
                                   AuditPort audit, ClockPort clock) {
        this.chatAccess = chatAccess;
        this.deliveries = deliveries;
        this.tokens = tokens;
        this.envelope = envelope;
        this.secretCipher = secretCipher;
        this.properties = properties;
        this.rateLimit = rateLimit;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public BotCommandResult invoke(Principal principal, UUID chatId, String command,
                                   String args) {
        String name = BotCommand.normalizeName(command);
        String normalizedArgs = normalizeArgs(args);
        BotChatAccess access = chatAccess.requireActiveChat(principal, chatId);
        if ("E2EE".equals(access.securityMode())) {
            throw DomainException.unprocessable(ErrorCode.BOT_E2EE_UNSUPPORTED,
                    "Bot commands are not available in an E2EE chat",
                    Map.of("reason", ErrorCode.BOT_E2EE_UNSUPPORTED));
        }
        rateLimit.checkBotCommand(principal, chatId);

        List<BotEventTarget> candidates = deliveries.findTargets(access.workspaceId(), chatId)
                .stream()
                .filter(target -> target.hasCommand(name))
                .toList();
        if (candidates.isEmpty()) {
            throw DomainException.notFound(ErrorCode.BOT_COMMAND_NOT_FOUND,
                    "No installed bot registers this command",
                    Map.of("command", name));
        }
        if (candidates.size() > 1) {
            throw DomainException.conflict(ErrorCode.BOT_COMMAND_AMBIGUOUS,
                    "More than one installed bot registers this command",
                    Map.of("command", name));
        }
        BotEventTarget target = candidates.get(0);
        if (!target.webhookReady()) {
            throw DomainException.unprocessable(ErrorCode.BOT_EVENTS_NOT_CONFIGURED,
                    "The bot has no active event endpoint",
                    Map.of("bot_id", target.botId().toString()));
        }

        Instant now = clock.now();
        UUID tokenId = UUID.randomUUID();
        String rawToken = BotResponseTokens.newRawToken(access.workspaceId(), tokenId);
        tokens.save(new BotCommandToken(tokenId, access.workspaceId(), chatId, target.botId(),
                principal.userId(), name, BotResponseTokens.hash(rawToken),
                now.plus(properties.responseTokenTtl()), null, null, now));

        UUID deliveryId = UUID.randomUUID();
        String json = envelope.slashCommand(tokenId, access.workspaceId(), chatId,
                principal.userId(), name, normalizedArgs, properties.responseUrl(rawToken), now);
        byte[] payload = secretCipher.encryptPayload(json, deliveryId);
        deliveries.enqueue(new BotEventDelivery(deliveryId, access.workspaceId(),
                target.botId(), chatId, BotEventType.SLASH_COMMAND, tokenId, payload,
                BotDeliveryStatus.PENDING, 0, now, null, null, now, now, null));

        audit.append(new AuditRecord(access.workspaceId(), principal.userId(), ACTION,
                "chat", chatId, principal.requestId(),
                Map.of("bot_id", target.botId().toString(), "command", name), now));
        return new BotCommandResult(deliveryId, target.botId());
    }

    private static String normalizeArgs(String args) {
        if (args == null) {
            return "";
        }
        String value = args.strip();
        if (value.length() > ARGS_MAX_LENGTH) {
            throw DomainException.unprocessable(ErrorCode.VALIDATION_FAILED,
                    "args must be at most 2000 characters",
                    Map.of("field", "args", "max_length", ARGS_MAX_LENGTH));
        }
        return value;
    }

    public record BotCommandResult(UUID deliveryId, UUID botId) {
    }
}
