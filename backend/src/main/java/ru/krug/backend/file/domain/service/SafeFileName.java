package ru.krug.backend.file.domain.service;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;

/**
 * Display-name policy for global workspace files (#83). The object key is always generated
 * from server-side UUIDs, so the filename is untrusted presentation data only; it must still
 * not carry path separators, control/bidi characters or an unbounded length (log/UI safety).
 */
public final class SafeFileName {

    public static final int MAX_LENGTH = 255;

    private SafeFileName() {
    }

    /**
     * Normalises and validates a user supplied filename.
     *
     * @throws DomainException 400 {@code VALIDATION_FAILED} for an empty, over-long or
     *         unsafe name
     */
    public static String require(String filename) {
        if (filename == null) {
            throw invalid("missing");
        }
        String value = filename.strip();
        if (value.isEmpty() || value.length() > MAX_LENGTH) {
            throw invalid("length");
        }
        if (".".equals(value) || "..".equals(value)) {
            throw invalid("reserved");
        }
        for (int index = 0; index < value.length(); index++) {
            char ch = value.charAt(index);
            if (ch == '/' || ch == '\\' || ch == '\0' || Character.isISOControl(ch)
                    || isBidiControl(ch)) {
                throw invalid("unsafe_character");
            }
        }
        return value;
    }

    private static boolean isBidiControl(char ch) {
        return (ch >= '\u202A' && ch <= '\u202E') || (ch >= '\u2066' && ch <= '\u2069');
    }

    private static DomainException invalid(String reason) {
        return DomainException.badRequest("filename is not a safe display name",
                Map.of("field", "filename", "reason", reason));
    }
}
