package ru.krug.backend.bot.application.usecase;

import java.util.Optional;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.bot.application.model.BotPrincipal;
import ru.krug.backend.bot.application.service.BotTokens;
import ru.krug.backend.bot.domain.model.Bot;
import ru.krug.backend.bot.domain.repository.BotRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;

/**
 * Authenticates {@code Authorization: Bearer sova_bot_...} for the dedicated bot API.
 *
 * <p>The token carries only the non-secret workspace/bot ids so the tenant RLS context can be
 * activated before the row is read. The presented token is then hashed and compared with the
 * stored SHA-256 in constant time ({@link java.security.MessageDigest#isEqual}). A disabled
 * or missing bot, a malformed token and a token for another bot id all produce the same empty
 * result, which the transport maps to a generic 401.</p>
 */
@Service
public class BotTokenAuthenticator {

    private final TenantContext tenantContext;
    private final BotRepository bots;

    public BotTokenAuthenticator(TenantContext tenantContext, BotRepository bots) {
        this.tenantContext = tenantContext;
        this.bots = bots;
    }

    @Transactional(readOnly = true)
    public Optional<BotPrincipal> authenticate(String rawToken, UUID pathBotId,
                                               String requestId) {
        if (rawToken == null || rawToken.isBlank()) {
            return Optional.empty();
        }
        Optional<BotTokens.Parsed> parsed = BotTokens.parse(rawToken);
        if (parsed.isEmpty()) {
            return Optional.empty();
        }
        BotTokens.Parsed identity = parsed.get();
        if (pathBotId == null || !pathBotId.equals(identity.botId())) {
            return Optional.empty();
        }
        tenantContext.activate(new Principal(identity.botId(), null, identity.workspaceId(),
                requestId));
        Bot bot = bots.findById(identity.workspaceId(), identity.botId()).orElse(null);
        if (bot == null || !bot.isActive()
                || !bot.matchesTokenHash(BotTokens.hash(rawToken))) {
            return Optional.empty();
        }
        return Optional.of(new BotPrincipal(bot.id(), bot.workspaceId(), bot.name(),
                bot.scopes(), requestId));
    }
}
