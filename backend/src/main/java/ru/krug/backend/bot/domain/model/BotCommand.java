package ru.krug.backend.bot.domain.model;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

import ru.krug.backend.shared.error.DomainException;

/**
 * A slash command registered by a bot owner. The name is lowercase, 1..32 characters and
 * unique inside one bot; the description is a short human hint (1..256). The leading slash
 * is an invocation detail, never part of the stored name.
 */
public record BotCommand(String command, String description) {

    public static final int COMMAND_MAX_LENGTH = 32;
    public static final int DESCRIPTION_MAX_LENGTH = 256;
    public static final int MAX_COMMANDS = 50;
    private static final Pattern NAME = Pattern.compile("^[a-z0-9][a-z0-9_-]{0,31}$");

    public BotCommand {
        command = normalizeName(command);
        description = normalizeDescription(description);
    }

    public static BotCommand of(String command, String description) {
        return new BotCommand(command, description);
    }

    /** Validates a requested list and rejects duplicate command names. */
    public static List<BotCommand> normalize(List<BotCommand> requested) {
        if (requested == null) {
            return List.of();
        }
        if (requested.size() > MAX_COMMANDS) {
            throw DomainException.badRequest("A bot can register at most 50 commands",
                    Map.of("field", "commands", "max_items", MAX_COMMANDS));
        }
        List<BotCommand> result = new ArrayList<>();
        Set<String> names = new HashSet<>();
        for (BotCommand item : requested) {
            if (item == null) {
                throw DomainException.badRequest("A command entry must not be null",
                        Map.of("field", "commands"));
            }
            if (!names.add(item.command())) {
                throw DomainException.badRequest("Command names must be unique",
                        Map.of("field", "commands", "command", item.command()));
            }
            result.add(item);
        }
        return List.copyOf(result);
    }

    /** Parses the wire representation ({@code {"command","description"}}). */
    public static BotCommand fromWire(String command, String description) {
        return of(command, description);
    }

    public static String normalizeName(String value) {
        String name = value == null ? "" : value.strip().toLowerCase(Locale.ROOT);
        if (name.startsWith("/")) {
            name = name.substring(1);
        }
        if (name.length() < 1 || name.length() > COMMAND_MAX_LENGTH
                || !NAME.matcher(name).matches()) {
            throw DomainException.badRequest("command must match [a-z0-9][a-z0-9_-]{0,31}",
                    Map.of("field", "command", "max_length", COMMAND_MAX_LENGTH));
        }
        return name;
    }

    private static String normalizeDescription(String value) {
        String description = value == null ? "" : value.strip();
        if (description.isEmpty() || description.length() > DESCRIPTION_MAX_LENGTH) {
            throw DomainException.badRequest("command description must be 1..256 characters",
                    Map.of("field", "description", "max_length", DESCRIPTION_MAX_LENGTH));
        }
        return description;
    }
}
