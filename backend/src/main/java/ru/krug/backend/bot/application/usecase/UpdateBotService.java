package ru.krug.backend.bot.application.usecase;

import java.time.Instant;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.bot.application.command.UpdateBotCommand;
import ru.krug.backend.bot.application.model.BotView;
import ru.krug.backend.bot.application.port.BotAvatarPort;
import ru.krug.backend.bot.domain.model.Bot;
import ru.krug.backend.bot.domain.model.BotStatus;
import ru.krug.backend.bot.domain.repository.BotRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;

/**
 * {@code PATCH /workspaces/{workspaceId}/bots/{botId}} (OWNER/ADMIN). Name, scopes, status
 * and avatar reference are mutable; the credential is only rotated by the dedicated token
 * endpoint. Audit metadata is ids only — never a token or a hash.
 */
@Service
public class UpdateBotService {

    static final String ACTION = "bot.updated";

    private final BotAccessGuard access;
    private final BotRepository bots;
    private final BotAvatarPort avatars;
    private final AuditPort audit;
    private final ClockPort clock;

    public UpdateBotService(BotAccessGuard access, BotRepository bots, BotAvatarPort avatars,
                            AuditPort audit, ClockPort clock) {
        this.access = access;
        this.bots = bots;
        this.avatars = avatars;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public BotView update(Principal principal, UUID workspaceId, UUID botId,
                          UpdateBotCommand command) {
        access.requireManager(principal, workspaceId);
        Bot bot = bots.findByIdForUpdate(workspaceId, botId)
                .orElseThrow(() -> BotErrors.notFound(workspaceId, botId));
        Instant now = clock.now();
        boolean changed = false;

        if (command.name() != null) {
            bot = bot.rename(command.name(), now);
            changed = true;
        }
        if (command.scopes() != null) {
            bot = bot.changeScopes(command.scopes(), now);
            changed = true;
        }
        if (command.status() != null) {
            BotStatus status = parseStatus(command.status());
            if (status != bot.status()) {
                bot = status == BotStatus.ACTIVE ? bot.enable(now) : bot.disable(now);
                changed = true;
            }
        }
        if (command.clearAvatar() && command.avatarFileId() != null) {
            throw DomainException.badRequest("avatar_file_id and clear_avatar are exclusive",
                    Map.of("field", "avatar_file_id"));
        }
        if (command.clearAvatar()) {
            if (bot.avatarFileId() != null) {
                bot = bot.changeAvatar(null, now);
                changed = true;
            }
        } else if (command.avatarFileId() != null) {
            UUID avatarId = avatars.requireImage(workspaceId, command.avatarFileId());
            if (!avatarId.equals(bot.avatarFileId())) {
                bot = bot.changeAvatar(avatarId, now);
                changed = true;
            }
        }

        if (changed) {
            bots.save(bot);
            audit.append(new AuditRecord(workspaceId, principal.userId(), ACTION, "bot", botId,
                    principal.requestId(), Map.of(), now));
        }
        return BotView.from(bot);
    }

    private static BotStatus parseStatus(String value) {
        try {
            return BotStatus.valueOf(value.strip().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException ex) {
            throw DomainException.badRequest("status must be ACTIVE or DISABLED",
                    Map.of("field", "status", "allowed", "ACTIVE,DISABLED"));
        }
    }
}
