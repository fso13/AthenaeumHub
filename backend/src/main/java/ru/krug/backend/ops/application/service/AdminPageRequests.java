package ru.krug.backend.ops.application.service;

import java.util.Locale;
import java.util.Map;
import java.util.Set;

import ru.krug.backend.ops.application.model.AdminPageCursor;
import ru.krug.backend.shared.error.DomainException;

/** Shared validation for the admin cursor pages: limit, literal search and chat type. */
public final class AdminPageRequests {

    public static final int DEFAULT_LIMIT = 30;
    public static final int MAX_LIMIT = 100;

    private static final Set<String> CHAT_TYPES = Set.of("DIRECT", "GROUP");

    private AdminPageRequests() {
    }

    public static int limit(Integer requested) {
        int limit = requested == null ? DEFAULT_LIMIT : requested;
        if (limit < 1 || limit > MAX_LIMIT) {
            throw DomainException.badRequest("limit must be between 1 and " + MAX_LIMIT,
                    Map.of("field", "limit", "min", 1, "max", MAX_LIMIT));
        }
        return limit;
    }

    /**
     * Normalises a literal substring search. Blank means "no filter"; excessively long
     * input is rejected instead of being truncated (a silent truncation would widen the
     * result set in a way the admin did not ask for).
     */
    public static String query(String raw, int maxLength) {
        if (raw == null) {
            return null;
        }
        String normalized = raw.strip();
        if (normalized.length() > maxLength) {
            throw DomainException.badRequest("query must be at most " + maxLength + " characters",
                    Map.of("field", "query", "max", maxLength));
        }
        return normalized.isEmpty() ? null : normalized;
    }

    public static AdminPageCursor cursor(String raw, String scope) {
        return raw == null || raw.isBlank() ? null : AdminPageCursor.decode(raw, scope);
    }

    /**
     * Optional exact audit-action filter. Blank means "no filter"; an over-long value is a
     * 400 instead of a silent truncation, which would widen the result set.
     */
    public static String action(String raw, int maxLength) {
        if (raw == null) {
            return null;
        }
        String normalized = raw.strip();
        if (normalized.length() > maxLength) {
            throw DomainException.badRequest(
                    "action must be at most " + maxLength + " characters",
                    Map.of("field", "action", "max", maxLength));
        }
        return normalized.isEmpty() ? null : normalized;
    }

    /** Optional chat type filter; blank means "no filter", values are case-insensitive. */
    public static String chatType(String raw) {
        if (raw == null) {
            return null;
        }
        String normalized = raw.strip().toUpperCase(Locale.ROOT);
        if (normalized.isEmpty()) {
            return null;
        }
        if (!CHAT_TYPES.contains(normalized)) {
            throw DomainException.badRequest("type must be DIRECT or GROUP",
                    Map.of("field", "type"));
        }
        return normalized;
    }
}
