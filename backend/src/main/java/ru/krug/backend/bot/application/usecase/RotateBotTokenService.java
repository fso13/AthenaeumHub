package ru.krug.backend.bot.application.usecase;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.bot.application.model.BotView;
import ru.krug.backend.bot.application.model.IssuedBotToken;
import ru.krug.backend.bot.application.service.BotTokens;
import ru.krug.backend.bot.domain.model.Bot;
import ru.krug.backend.bot.domain.repository.BotRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;

/**
 * {@code POST /workspaces/{workspaceId}/bots/{botId}/token} (OWNER/ADMIN). Replaces the
 * stored hash in the same transaction, so the previous token stops authenticating immediately
 * and the new raw token is returned exactly once. Rotation works for a disabled bot too, but
 * the token is usable only after the bot is re-enabled.
 */
@Service
public class RotateBotTokenService {

    static final String ACTION = "bot.token.rotated";

    private final BotAccessGuard access;
    private final BotRepository bots;
    private final AuditPort audit;
    private final ClockPort clock;

    public RotateBotTokenService(BotAccessGuard access, BotRepository bots, AuditPort audit,
                                 ClockPort clock) {
        this.access = access;
        this.bots = bots;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public IssuedBotToken rotate(Principal principal, UUID workspaceId, UUID botId) {
        access.requireManager(principal, workspaceId);
        Bot bot = bots.findByIdForUpdate(workspaceId, botId)
                .orElseThrow(() -> BotErrors.notFound(workspaceId, botId));
        Instant now = clock.now();
        String rawToken = BotTokens.newRawToken(workspaceId, botId);
        Bot rotated = bot.rotateToken(BotTokens.hash(rawToken), now);
        bots.save(rotated);
        audit.append(new AuditRecord(workspaceId, principal.userId(), ACTION, "bot", botId,
                principal.requestId(), Map.of(), now));
        return new IssuedBotToken(BotView.from(rotated), rawToken);
    }
}
