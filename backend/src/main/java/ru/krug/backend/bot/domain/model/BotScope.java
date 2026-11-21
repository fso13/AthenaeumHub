package ru.krug.backend.bot.domain.model;

import java.util.List;
import java.util.Locale;
import java.util.Map;

import ru.krug.backend.shared.error.DomainException;

/**
 * MVP bot capability set. A bot token can only post messages: reading history, calls,
 * files, uploads and admin surfaces are deliberately not scoped here. A future
 * {@code chat.read} or event-subscription scope needs a new migration and an explicit
 * contract change.
 */
public enum BotScope {

    CHAT_WRITE("chat.write");

    private final String wire;

    BotScope(String wire) {
        this.wire = wire;
    }

    public String wire() {
        return wire;
    }

    /**
     * Normalizes a requested scope list: trims, lower-cases, de-duplicates and rejects an
     * unknown or empty set with a semantic 400. Order is preserved for stable responses.
     */
    public static List<String> normalize(List<String> requested) {
        if (requested == null || requested.isEmpty()) {
            throw DomainException.badRequest("scopes must contain at least one scope",
                    Map.of("field", "scopes", "allowed", allowed()));
        }
        List<String> result = requested.stream()
                .map(scope -> scope == null ? "" : scope.strip().toLowerCase(Locale.ROOT))
                .distinct()
                .toList();
        if (result.isEmpty() || result.stream().anyMatch(String::isBlank)) {
            throw DomainException.badRequest("scopes must not contain blank values",
                    Map.of("field", "scopes", "allowed", allowed()));
        }
        for (String scope : result) {
            if (fromWire(scope) == null) {
                throw DomainException.badRequest("scope is not supported in this MVP",
                        Map.of("field", "scopes", "scope", scope, "allowed", allowed()));
            }
        }
        return result;
    }

    public static BotScope fromWire(String value) {
        if (value == null) {
            return null;
        }
        String normalized = value.strip().toLowerCase(Locale.ROOT);
        for (BotScope scope : values()) {
            if (scope.wire.equals(normalized)) {
                return scope;
            }
        }
        return null;
    }

    public static List<String> allowed() {
        return List.of(CHAT_WRITE.wire);
    }
}
