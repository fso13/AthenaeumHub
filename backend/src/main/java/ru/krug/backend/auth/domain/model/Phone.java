package ru.krug.backend.auth.domain.model;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;

/**
 * Free-form plain-text contact phone (0..32 characters). The value is deliberately not
 * parsed into E.164 in this slice: international formats, extensions and separators are
 * preserved exactly as entered. Blank input is normalized to {@code null}.
 */
public record Phone(String value) {

    public static final int MAX_LENGTH = 32;

    public Phone {
        String normalized = value == null ? null : value.strip();
        if (normalized != null && normalized.isEmpty()) {
            normalized = null;
        }
        if (normalized != null) {
            if (normalized.length() > MAX_LENGTH) {
                throw DomainException.badRequest("phone must be at most 32 characters",
                        Map.of("field", "phone", "max_length", MAX_LENGTH));
            }
            if (Bio.containsForbiddenControl(normalized, false)) {
                throw DomainException.badRequest("phone must be plain text",
                        Map.of("field", "phone", "reason", "control_characters"));
            }
        }
        value = normalized;
    }

    public static Phone empty() {
        return new Phone(null);
    }
}
