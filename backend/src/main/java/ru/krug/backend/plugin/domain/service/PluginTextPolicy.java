package ru.krug.backend.plugin.domain.service;

import java.util.regex.Pattern;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Plain-text rules for the plugin actions. Questions/titles/options are single-line plain
 * text: controls (including newlines) and HTML brackets are rejected, and surrounding
 * whitespace is stripped. Translation output is allowed to contain newlines/tabs but is
 * still rejected if it looks like markup or contains other controls.
 *
 * <p>The rules are intentionally duplicated as a DB CHECK: the database is the backstop
 * for any write path that bypasses this policy.</p>
 */
public final class PluginTextPolicy {

    public static final int QUESTION_MAX = 500;
    public static final int OPTION_MAX = 200;
    public static final int TASK_TITLE_MAX = 500;
    public static final int TRANSLATION_MAX = 8000;

    private static final Pattern TARGET_LANGUAGE =
            Pattern.compile("^[a-z]{2,3}(-[A-Za-z]{2,4})?$");

    private PluginTextPolicy() {
    }

    public static String requireQuestion(String raw) {
        return requireSingleLine(raw, QUESTION_MAX, "question");
    }

    public static String requireOption(String raw) {
        return requireSingleLine(raw, OPTION_MAX, "option");
    }

    public static String requireTaskTitle(String raw) {
        return requireSingleLine(raw, TASK_TITLE_MAX, "title");
    }

    public static String requireTargetLanguage(String raw) {
        String value = raw == null ? "" : raw.strip();
        if (!TARGET_LANGUAGE.matcher(value).matches()) {
            throw DomainException.unprocessable(ErrorCode.VALIDATION_FAILED,
                    "target must be an ISO 639-1/2 language code",
                    java.util.Map.of("field", "target"));
        }
        return value;
    }

    /**
     * Provider output is untrusted. Normalises CRLF to LF, trims, bounds the length and
     * rejects controls (except newline/tab) and HTML brackets. An invalid provider answer
     * is reported as an unavailable translation, never as successful content.
     */
    public static String requireTranslated(String raw) {
        if (raw == null) {
            throw invalidProviderResponse();
        }
        String value = raw.replace("\r\n", "\n").replace('\r', '\n').strip();
        if (value.isEmpty() || value.length() > TRANSLATION_MAX) {
            throw invalidProviderResponse();
        }
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '<' || c == '>') {
                throw invalidProviderResponse();
            }
            if (Character.isISOControl(c) && c != '\n' && c != '\t') {
                throw invalidProviderResponse();
            }
            if (Character.isSurrogate(c)) {
                if (Character.isHighSurrogate(c) && i + 1 < value.length()
                        && Character.isLowSurrogate(value.charAt(i + 1))) {
                    i++;
                } else {
                    throw invalidProviderResponse();
                }
            }
        }
        return value;
    }

    private static String requireSingleLine(String raw, int maxLength, String field) {
        if (raw == null) {
            throw DomainException.unprocessable(ErrorCode.VALIDATION_FAILED,
                    field + " is required", java.util.Map.of("field", field));
        }
        String value = raw.strip();
        if (value.isEmpty()) {
            throw DomainException.unprocessable(ErrorCode.VALIDATION_FAILED,
                    field + " must not be empty", java.util.Map.of("field", field));
        }
        if (value.length() > maxLength) {
            throw DomainException.unprocessable(ErrorCode.VALIDATION_FAILED,
                    field + " is too long",
                    java.util.Map.of("field", field, "max_length", maxLength));
        }
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '<' || c == '>' || Character.isISOControl(c)) {
                throw DomainException.unprocessable(ErrorCode.VALIDATION_FAILED,
                        field + " must be plain text without markup or controls",
                        java.util.Map.of("field", field));
            }
            if (Character.isSurrogate(c)) {
                if (Character.isHighSurrogate(c) && i + 1 < value.length()
                        && Character.isLowSurrogate(value.charAt(i + 1))) {
                    i++;
                } else {
                    throw DomainException.unprocessable(ErrorCode.VALIDATION_FAILED,
                            field + " contains an invalid character",
                            java.util.Map.of("field", field));
                }
            }
        }
        return value;
    }

    private static DomainException invalidProviderResponse() {
        return DomainException.serviceUnavailable(ErrorCode.TRANSLATION_UNAVAILABLE,
                "Translation provider returned an unusable response",
                java.util.Map.of("reason", "invalid_provider_response"), 30L);
    }
}
