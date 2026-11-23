package ru.krug.backend.bot.domain.model;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import ru.krug.backend.shared.error.DomainException;

/**
 * Bot webhook event types.
 *
 * <p>A bot may subscribe only to the two message events; {@code slash_command} is delivered
 * because the bot registered the command, and {@code test} only from the explicit ping
 * endpoint. Defining the wire set here keeps the DB constraint, the API enum and the
 * dispatcher on one source of truth.</p>
 */
public enum BotEventType {

    MESSAGE_CREATED("message.created", true),
    APP_MENTION("app_mention", true),
    SLASH_COMMAND("slash_command", false),
    TEST("test", false);

    private final String wire;
    private final boolean subscribable;

    BotEventType(String wire, boolean subscribable) {
        this.wire = wire;
        this.subscribable = subscribable;
    }

    public String wire() {
        return wire;
    }

    public boolean subscribable() {
        return subscribable;
    }

    public static BotEventType fromWire(String value) {
        if (value == null) {
            return null;
        }
        String normalized = value.strip().toLowerCase(Locale.ROOT);
        for (BotEventType type : values()) {
            if (type.wire.equals(normalized)) {
                return type;
            }
        }
        return null;
    }

    /** Normalizes a requested subscription list (trim/lowercase/de-duplicate/preserve order). */
    public static List<String> normalizeSubscriptions(List<String> requested) {
        if (requested == null) {
            return List.of();
        }
        List<String> result = new ArrayList<>();
        for (String raw : requested) {
            BotEventType type = raw == null ? null : fromWire(raw);
            if (type == null || !type.subscribable()) {
                throw DomainException.badRequest("Unsupported bot event subscription",
                        Map.of("field", "events", "value", String.valueOf(raw),
                                "allowed", subscribableWires()));
            }
            if (!result.contains(type.wire)) {
                result.add(type.wire);
            }
        }
        return List.copyOf(result);
    }

    public static List<String> subscribableWires() {
        return List.of(MESSAGE_CREATED.wire, APP_MENTION.wire);
    }
}
