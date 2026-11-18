package ru.krug.backend.chat.domain.service;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * D1-BE3 normalisation and validation of editable chat settings. Kept in the domain so
 * every write path (API, future admin tooling) shares the same rules:
 *
 * <ul>
 *   <li>{@code name}: trimmed, internal whitespace collapsed, 1..120 Unicode code points;
 *       no {@code <}/{@code >} and no control characters — plain text only;</li>
 *   <li>{@code description}: CRLF normalised, trimmed, at most 500 code points; empty
 *       becomes {@code null} (clearing the field); {@code \n}/{@code \t} are allowed,
 *       other control characters and {@code <}/{@code >} are rejected.</li>
 * </ul>
 *
 * <p>Violations are semantic {@code 422 VALIDATION_FAILED} with the field and its bound in
 * {@code details}; nothing is truncated silently.</p>
 */
public final class ChatSettingsPolicy {

    public static final int NAME_MAX_LENGTH = 120;
    public static final int DESCRIPTION_MAX_LENGTH = 500;

    private ChatSettingsPolicy() {
    }

    public static String name(String raw) {
        String value = raw == null ? "" : raw.strip().replaceAll("\\s+", " ");
        requirePlainText(value, "name");
        int length = codePoints(value);
        if (length < 1 || length > NAME_MAX_LENGTH) {
            throw invalid("name", "name must be 1.." + NAME_MAX_LENGTH + " characters",
                    Map.of("field", "name", "max_length", NAME_MAX_LENGTH, "length", length));
        }
        return value;
    }

    /** @return {@code null} for a blank value (the caller interprets it as "clear"). */
    public static String description(String raw) {
        if (raw == null) {
            return null;
        }
        String value = raw.replace("\r\n", "\n").replace('\r', '\n').strip();
        if (value.isEmpty()) {
            return null;
        }
        requirePlainText(value, "description");
        int length = codePoints(value);
        if (length > DESCRIPTION_MAX_LENGTH) {
            throw invalid("description",
                    "description must be at most " + DESCRIPTION_MAX_LENGTH + " characters",
                    Map.of("field", "description", "max_length", DESCRIPTION_MAX_LENGTH,
                            "length", length));
        }
        return value;
    }

    /**
     * E2EE chats expose only opaque metadata; a free-form description is product content
     * and is not accepted. The name is still allowed because it is a chat label.
     */
    public static void requireDescriptionAllowed(boolean e2ee) {
        if (e2ee) {
            throw DomainException.unprocessable(ErrorCode.CHAT_SETTINGS_E2EE_UNSUPPORTED,
                    "Description is not supported for an E2EE chat",
                    Map.of("field", "description", "security_mode", "E2EE"));
        }
    }

    private static void requirePlainText(String value, String field) {
        for (int i = 0; i < value.length(); ) {
            int codePoint = value.codePointAt(i);
            boolean allowedWhitespace = "description".equals(field)
                    && (codePoint == '\n' || codePoint == '\t');
            if ((codePoint == '<' || codePoint == '>')
                    || (Character.isISOControl(codePoint) && !allowedWhitespace)
                    || isBidiControl(codePoint)) {
                throw invalid(field, field + " must be plain text without HTML or control "
                        + "characters", Map.of("field", field, "reason", "plain_text_required"));
            }
            i += Character.charCount(codePoint);
        }
    }

    private static boolean isBidiControl(int codePoint) {
        return (codePoint >= 0x202A && codePoint <= 0x202E)
                || (codePoint >= 0x2066 && codePoint <= 0x2069)
                || codePoint == 0x200E || codePoint == 0x200F;
    }

    private static int codePoints(String value) {
        return value.codePointCount(0, value.length());
    }

    private static DomainException invalid(String field, String message,
                                           Map<String, Object> details) {
        return DomainException.unprocessable(ErrorCode.VALIDATION_FAILED, message, details);
    }
}
