package ru.krug.backend.bot.application.usecase;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.bot.domain.model.Bot;
import ru.krug.backend.bot.domain.repository.BotRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;

/**
 * {@code DELETE /workspaces/{workspaceId}/bots/{botId}}: soft delete (status DISABLED). The
 * row and its installations stay for history, but the token authenticates nothing. The
 * operation is idempotent: a second DELETE is a 204 no-op without a second audit event.
 */
@Service
public class DisableBotService {

    static final String ACTION = "bot.disabled";

    private final BotAccessGuard access;
    private final BotRepository bots;
    private final AuditPort audit;
    private final ClockPort clock;

    public DisableBotService(BotAccessGuard access, BotRepository bots, AuditPort audit,
                             ClockPort clock) {
        this.access = access;
        this.bots = bots;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public void disable(Principal principal, UUID workspaceId, UUID botId) {
        access.requireManager(principal, workspaceId);
        Bot bot = bots.findByIdForUpdate(workspaceId, botId)
                .orElseThrow(() -> BotErrors.notFound(workspaceId, botId));
        if (!bot.isActive()) {
            return;
        }
        Instant now = clock.now();
        bots.save(bot.disable(now));
        audit.append(new AuditRecord(workspaceId, principal.userId(), ACTION, "bot", botId,
                principal.requestId(), Map.of(), now));
    }
}
