package ru.krug.backend.workspace.application.service;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.workspace.domain.model.DlpAction;
import ru.krug.backend.workspace.domain.model.DlpPatternType;

/**
 * Validation of DLP rule input. Patterns are literal, bounded values:
 * <ul>
 *   <li>{@code KEYWORD} — a case-insensitive literal substring;</li>
 *   <li>{@code PATTERN} — the same, plus the {@code *} wildcard (at most 20).</li>
 * </ul>
 * Nothing is ever compiled as a regular expression, so a stored rule cannot cause
 * catastrophic backtracking. Control characters are rejected, and the length is capped at
 * 200 characters. A workspace is capped at 100 rules to bound any future evaluation pass.
 */
public final class DlpPolicyRequests {

    public static final int MAX_NAME_LENGTH = 120;
    public static final int MAX_PATTERN_LENGTH = 200;
    public static final int MAX_WILDCARDS = 20;
    public static final int MAX_POLICIES_PER_WORKSPACE = 100;

    private DlpPolicyRequests() {
    }

    public static String name(String raw) {
        String value = text(raw, "name", MAX_NAME_LENGTH);
        if (value == null) {
            throw DomainException.badRequest("name is required", Map.of("field", "name"));
        }
        return value;
    }

    public static DlpAction action(String raw) {
        String value = text(raw, "action", 16);
        if (value == null) {
            throw DomainException.badRequest("action is required", Map.of("field", "action"));
        }
        return parseAction(value);
    }

    /** Optional exact filter; blank means "no filter", an unknown literal is a 400. */
    public static DlpAction optionalAction(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        return parseAction(raw.strip());
    }

    private static DlpAction parseAction(String value) {
        try {
            return DlpAction.valueOf(value.toUpperCase(java.util.Locale.ROOT));
        } catch (IllegalArgumentException ex) {
            throw DomainException.badRequest("action must be WARN or BLOCK",
                    Map.of("field", "action", "allowed", java.util.List.of("WARN", "BLOCK")));
        }
    }

    public static DlpPatternType patternType(String raw) {
        String value = text(raw, "pattern_type", 16);
        if (value == null) {
            throw DomainException.badRequest("pattern_type is required",
                    Map.of("field", "pattern_type"));
        }
        try {
            return DlpPatternType.valueOf(value.toUpperCase(java.util.Locale.ROOT));
        } catch (IllegalArgumentException ex) {
            throw DomainException.badRequest("pattern_type must be KEYWORD or PATTERN",
                    Map.of("field", "pattern_type",
                            "allowed", java.util.List.of("KEYWORD", "PATTERN")));
        }
    }

    public static String pattern(String raw, DlpPatternType type) {
        String value = text(raw, "pattern", MAX_PATTERN_LENGTH);
        if (value == null) {
            throw DomainException.badRequest("pattern is required", Map.of("field", "pattern"));
        }
        if (type == DlpPatternType.PATTERN && countWildcards(value) > MAX_WILDCARDS) {
            throw DomainException.badRequest(
                    "pattern must contain at most " + MAX_WILDCARDS + " wildcards",
                    Map.of("field", "pattern", "max_wildcards", MAX_WILDCARDS));
        }
        return value;
    }

    public static boolean enabled(Boolean raw) {
        return raw == null || raw;
    }

    /**
     * Strips and bounds a text field, rejects control characters and blank values. A null
     * input returns null so a PATCH can distinguish "absent" from an explicit empty value.
     */
    private static String text(String raw, String field, int maxLength) {
        if (raw == null) {
            return null;
        }
        String value = raw.strip();
        if (value.isEmpty()) {
            return null;
        }
        if (value.length() > maxLength) {
            throw DomainException.badRequest(
                    field + " must be at most " + maxLength + " characters",
                    Map.of("field", field, "max", maxLength));
        }
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character < 0x20 || character == 0x7F) {
                throw DomainException.badRequest(field + " must not contain control characters",
                        Map.of("field", field));
            }
        }
        return value;
    }

    private static int countWildcards(String value) {
        int count = 0;
        for (int index = 0; index < value.length(); index++) {
            if (value.charAt(index) == '*') {
                count++;
            }
        }
        return count;
    }
}
