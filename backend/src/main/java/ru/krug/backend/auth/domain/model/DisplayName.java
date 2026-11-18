package ru.krug.backend.auth.domain.model;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;

/**
 * Value object with the display-name invariant (1..80 characters).
 */
public record DisplayName(String value) {

    public static final int MAX_LENGTH = 80;

    public DisplayName {
        String normalized = value == null ? null : value.strip();
        if (normalized == null || normalized.isEmpty()) {
            throw DomainException.badRequest("display_name must not be blank",
                    Map.of("field", "display_name", "reason", "blank"));
        }
        if (normalized.length() > MAX_LENGTH) {
            throw DomainException.badRequest("display_name must be at most 80 characters",
                    Map.of("field", "display_name", "max_length", MAX_LENGTH));
        }
        value = normalized;
    }
}
