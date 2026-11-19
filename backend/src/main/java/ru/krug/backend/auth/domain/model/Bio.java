package ru.krug.backend.auth.domain.model;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;

/**
 * Free-form plain-text profile bio (0..280 characters). Blank input is normalized to
 * {@code null}, so an explicit empty value clears the field. Markup is not interpreted or
 * stripped: the server stores text verbatim and clients must render it as text.
 */
public record Bio(String value) {

    public static final int MAX_LENGTH = 280;

    public Bio {
        String normalized = value == null ? null : value.strip();
        if (normalized != null && normalized.isEmpty()) {
            normalized = null;
        }
        if (normalized != null) {
            if (normalized.length() > MAX_LENGTH) {
                throw DomainException.badRequest("bio must be at most 280 characters",
                        Map.of("field", "bio", "max_length", MAX_LENGTH));
            }
            if (containsForbiddenControl(normalized, true)) {
                throw DomainException.badRequest("bio must be plain text",
                        Map.of("field", "bio", "reason", "control_characters"));
            }
        }
        value = normalized;
    }

    public static Bio empty() {
        return new Bio(null);
    }

    /**
     * ISO control characters are never valid profile text. Line breaks and tabs are
     * allowed in a bio (multi-line plain text) but not in a phone number.
     */
    static boolean containsForbiddenControl(String text, boolean allowLineBreaks) {
        return text.codePoints().anyMatch(codePoint -> {
            if (codePoint == '\u0000') {
                return true;
            }
            if (!Character.isISOControl(codePoint)) {
                return false;
            }
            return !allowLineBreaks || (codePoint != '\n' && codePoint != '\r'
                    && codePoint != '\t');
        });
    }
}
