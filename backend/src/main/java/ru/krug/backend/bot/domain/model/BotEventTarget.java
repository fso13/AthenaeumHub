package ru.krug.backend.bot.domain.model;

import java.util.List;
import java.util.UUID;

/**
 * Read projection of an active bot installed and enabled in a chat, with its event and
 * slash-command configuration. It intentionally carries no credential: the encrypted
 * signing secret is read by the delivery worker only.
 */
public record BotEventTarget(
        UUID botId,
        String name,
        String eventsUrl,
        List<String> eventTypes,
        boolean eventsEnabled,
        boolean hasSigningSecret,
        List<BotCommand> commands) {

    public BotEventTarget {
        eventTypes = eventTypes == null ? List.of() : List.copyOf(eventTypes);
        commands = commands == null ? List.of() : List.copyOf(commands);
    }

    public boolean subscribedTo(BotEventType type) {
        return eventsEnabled && eventTypes.contains(type.wire());
    }

    /**
     * Whether this target can actually receive a webhook right now. Event subscriptions are
     * a separate filter: an empty {@code eventTypes} is a slash-command-only bot.
     */
    public boolean webhookReady() {
        return eventsEnabled && eventsUrl != null && !eventsUrl.isBlank() && hasSigningSecret;
    }

    public boolean hasCommand(String command) {
        return commands.stream().anyMatch(item -> item.command().equals(command));
    }
}
