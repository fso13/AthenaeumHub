package ru.krug.backend.bot.application.model;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import ru.krug.backend.bot.domain.model.Bot;

/**
 * API/read projection of a bot. It contains no token and no token hash: a credential is
 * returned only once by create/rotate, never by a read endpoint. #98 adds the event
 * configuration and slash commands; {@code signingSecret} is set only by the one response
 * that generates/rotates it and is never part of a list.
 */
public record BotView(
        UUID id,
        UUID workspaceId,
        String name,
        UUID avatarFileId,
        List<String> scopes,
        String status,
        UUID createdBy,
        Instant createdAt,
        Instant updatedAt,
        Instant tokenRotatedAt,
        String eventsUrl,
        List<String> events,
        boolean eventsEnabled,
        boolean hasSigningSecret,
        Instant signingSecretCreatedAt,
        List<BotCommandView> commands,
        String signingSecret) {

    public BotView {
        scopes = scopes == null ? List.of() : List.copyOf(scopes);
        events = events == null ? List.of() : List.copyOf(events);
        commands = commands == null ? List.of() : List.copyOf(commands);
    }

    public static BotView from(Bot bot) {
        return from(bot, null);
    }

    public static BotView from(Bot bot, String signingSecret) {
        return new BotView(bot.id(), bot.workspaceId(), bot.name(), bot.avatarFileId(),
                bot.scopes(), bot.status().name(), bot.createdBy(), bot.createdAt(),
                bot.updatedAt(), bot.tokenRotatedAt(), bot.eventsUrl(), bot.eventTypes(),
                bot.eventsEnabled(), bot.hasSigningSecret(), bot.signingSecretCreatedAt(),
                BotCommandView.from(bot.commands()), signingSecret);
    }

    /** A list/read projection never reveals the secret. */
    public BotView withoutSecret() {
        return signingSecret == null ? this : new BotView(id, workspaceId, name, avatarFileId,
                scopes, status, createdBy, createdAt, updatedAt, tokenRotatedAt, eventsUrl,
                events, eventsEnabled, hasSigningSecret, signingSecretCreatedAt, commands,
                null);
    }
}
