package ru.krug.backend.bot.application.usecase;

import java.security.MessageDigest;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.bot.application.command.BotMessageCommand;
import ru.krug.backend.bot.application.model.BotPrincipal;
import ru.krug.backend.bot.application.service.BotResponseTokens;
import ru.krug.backend.bot.domain.model.Bot;
import ru.krug.backend.bot.domain.model.BotCommandToken;
import ru.krug.backend.bot.domain.repository.BotCommandTokenRepository;
import ru.krug.backend.bot.domain.repository.BotRepository;
import ru.krug.backend.message.application.model.MessageView;
import ru.krug.backend.ops.application.port.RateLimitPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * {@code POST /bot-responses/{token}}: the response-url half of a slash command.
 *
 * <p>The capability token is the entire authorization: no bot bearer and no user JWT is
 * required. It is one-time (atomically consumed in the same transaction as the bot message),
 * expires after 5 minutes and is stored only as a SHA-256 hash. The created message goes
 * through the normal {@link BotMessageService} pipeline, so scope, install, MANAGED-only and
 * rate-limit checks apply unchanged.</p>
 */
@Service
public class BotResponseService {

    private final TenantContext tenantContext;
    private final BotCommandTokenRepository tokens;
    private final BotRepository bots;
    private final BotMessageService messages;
    private final RateLimitPort rateLimit;
    private final ClockPort clock;

    public BotResponseService(TenantContext tenantContext, BotCommandTokenRepository tokens,
                              BotRepository bots, BotMessageService messages,
                              RateLimitPort rateLimit, ClockPort clock) {
        this.tenantContext = tenantContext;
        this.tokens = tokens;
        this.bots = bots;
        this.messages = messages;
        this.rateLimit = rateLimit;
        this.clock = clock;
    }

    @Transactional
    public MessageView respond(String rawToken, String text, String requestId) {
        BotResponseTokens.Parsed parsed = BotResponseTokens.parse(rawToken)
                .orElseThrow(BotResponseService::invalid);
        // The token id is not a secret; it activates the tenant RLS context before the row is
        // read. The capability itself is verified by a constant-time hash comparison below.
        tenantContext.activate(new Principal(parsed.tokenId(), null, parsed.workspaceId(),
                requestId));

        BotCommandToken token = tokens.findById(parsed.workspaceId(), parsed.tokenId())
                .orElseThrow(BotResponseService::invalid);
        if (!MessageDigest.isEqual(token.tokenHash(), BotResponseTokens.hash(rawToken))) {
            throw invalid();
        }
        Instant now = clock.now();
        if (token.consumedAt() != null) {
            throw DomainException.conflict(ErrorCode.BOT_RESPONSE_USED,
                    "This response token has already been used",
                    Map.of("reason", "token_used"));
        }
        if (token.expiresAt() == null || !token.expiresAt().isAfter(now)) {
            throw DomainException.gone(ErrorCode.BOT_RESPONSE_EXPIRED,
                    "This response token has expired", Map.of("reason", "token_expired"));
        }
        rateLimit.checkBotResponse(token.id(), token.botId());

        if (!tokens.consume(parsed.workspaceId(), parsed.tokenId(), now)) {
            throw DomainException.conflict(ErrorCode.BOT_RESPONSE_USED,
                    "This response token has already been used",
                    Map.of("reason", "token_used"));
        }

        Bot bot = bots.findById(parsed.workspaceId(), token.botId())
                .orElseThrow(BotResponseService::invalid);
        BotPrincipal principal = new BotPrincipal(bot.id(), parsed.workspaceId(), bot.name(),
                bot.scopes(), requestId);
        MessageView view = messages.send(principal, new BotMessageCommand(token.chatId(), text,
                token.id().toString())).message();
        tokens.attachResponseMessage(parsed.workspaceId(), parsed.tokenId(), view.id());
        return view;
    }

    private static DomainException invalid() {
        return DomainException.unauthorized(ErrorCode.BOT_RESPONSE_INVALID,
                "Invalid bot response token", Map.of());
    }

}
