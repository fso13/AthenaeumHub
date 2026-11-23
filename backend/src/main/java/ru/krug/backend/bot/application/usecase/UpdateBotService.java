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
import ru.krug.backend.bot.application.command.BotCommandInput;
import ru.krug.backend.bot.application.command.UpdateBotCommand;
import ru.krug.backend.bot.application.model.BotUpdateResult;
import ru.krug.backend.bot.application.model.BotView;
import ru.krug.backend.bot.application.port.BotAvatarPort;
import ru.krug.backend.bot.application.port.BotSecretCipherPort;
import ru.krug.backend.bot.application.service.BotEventsUrl;
import ru.krug.backend.bot.application.service.BotSigningSecrets;
import ru.krug.backend.bot.domain.model.Bot;
import ru.krug.backend.bot.domain.model.BotCommand;
import ru.krug.backend.bot.domain.model.BotStatus;
import ru.krug.backend.bot.domain.repository.BotRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;

/**
 * {@code PATCH /workspaces/{workspaceId}/bots/{botId}} (OWNER/ADMIN). Name, scopes, status,
 * avatar, event endpoint/subscriptions and slash commands are mutable; the credential is only
 * rotated by the dedicated token endpoint.
 *
 * <p>#98: enabling an event subscription without a stored secret generates one atomically and
 * returns it exactly once in this response. Audit metadata is ids only — never a token, hash,
 * signing secret or command payload.</p>
 */
@Service
public class UpdateBotService {

    static final String ACTION = "bot.updated";

    private final BotAccessGuard access;
    private final BotRepository bots;
    private final BotAvatarPort avatars;
    private final BotSecretCipherPort secretCipher;
    private final AuditPort audit;
    private final ClockPort clock;

    public UpdateBotService(BotAccessGuard access, BotRepository bots, BotAvatarPort avatars,
                            BotSecretCipherPort secretCipher, AuditPort audit, ClockPort clock) {
        this.access = access;
        this.bots = bots;
        this.avatars = avatars;
        this.secretCipher = secretCipher;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public BotUpdateResult update(Principal principal, UUID workspaceId, UUID botId,
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

        boolean eventSettingsTouched = command.eventsUrl() != null || command.events() != null
                || command.eventsEnabled() != null;
        if (eventSettingsTouched) {
            String url = command.eventsUrl() == null
                    ? bot.eventsUrl() : BotEventsUrl.normalize(command.eventsUrl());
            List<String> subscriptions = command.events() == null
                    ? bot.eventTypes() : command.events();
            boolean enabled = command.eventsEnabled() == null
                    ? bot.eventsEnabled() : command.eventsEnabled();
            Bot updated = bot.changeEventSettings(url, subscriptions, enabled, now);
            if (!sameEventSettings(bot, updated)) {
                bot = updated;
                changed = true;
            }
        }

        if (command.commands() != null) {
            List<BotCommand> commands = command.commands().stream()
                    .map(UpdateBotService::toCommand)
                    .toList();
            Bot updated = bot.changeCommands(commands, now);
            if (!updated.commands().equals(bot.commands())) {
                bot = updated;
                changed = true;
            }
        }

        String rawSecret = null;
        if (bot.eventsUrl() != null && bot.eventsEnabled() && !bot.hasSigningSecret()) {
            rawSecret = BotSigningSecrets.newSecret();
            bot = bot.rotateSigningSecret(secretCipher.encryptSecret(rawSecret, bot.id()), now);
            changed = true;
        }

        if (changed) {
            bots.save(bot);
            audit.append(new AuditRecord(workspaceId, principal.userId(), ACTION, "bot", botId,
                    principal.requestId(), Map.of(), now));
        }
        return new BotUpdateResult(BotView.from(bot, rawSecret), rawSecret);
    }

    private static boolean sameEventSettings(Bot before, Bot after) {
        return java.util.Objects.equals(before.eventsUrl(), after.eventsUrl())
                && before.eventTypes().equals(after.eventTypes())
                && before.eventsEnabled() == after.eventsEnabled();
    }

    private static BotCommand toCommand(BotCommandInput input) {
        if (input == null) {
            throw DomainException.badRequest("A command entry must not be null",
                    Map.of("field", "commands"));
        }
        return BotCommand.of(input.command(), input.description());
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
