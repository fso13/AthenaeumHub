package ru.krug.backend.bot.application.usecase;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.bot.application.command.CreateBotCommand;
import ru.krug.backend.bot.application.model.BotView;
import ru.krug.backend.bot.application.model.IssuedBotToken;
import ru.krug.backend.bot.application.service.BotTokens;
import ru.krug.backend.bot.domain.model.Bot;
import ru.krug.backend.bot.domain.repository.BotRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;

/**
 * {@code POST /workspaces/{workspaceId}/bots}. Workspace OWNER/ADMIN only. The response is
 * the only place where the raw token appears; the database stores just its SHA-256 hash and
 * the audit row contains ids only.
 */
@Service
public class CreateBotService {

    static final String ACTION = "bot.created";

    private final BotAccessGuard access;
    private final BotRepository bots;
    private final AuditPort audit;
    private final ClockPort clock;

    public CreateBotService(BotAccessGuard access, BotRepository bots, AuditPort audit,
                            ClockPort clock) {
        this.access = access;
        this.bots = bots;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public IssuedBotToken create(Principal principal, UUID workspaceId,
                                 CreateBotCommand command) {
        access.requireManager(principal, workspaceId);
        Instant now = clock.now();
        UUID botId = UUID.randomUUID();
        String rawToken = BotTokens.newRawToken(workspaceId, botId);
        Bot bot = Bot.create(botId, workspaceId, command.name(), null,
                BotTokens.hash(rawToken), command.scopes(), principal.userId(), now);
        bots.save(bot);
        audit.append(new AuditRecord(workspaceId, principal.userId(), ACTION, "bot", botId,
                principal.requestId(), Map.of(), now));
        return new IssuedBotToken(BotView.from(bot), rawToken);
    }
}
