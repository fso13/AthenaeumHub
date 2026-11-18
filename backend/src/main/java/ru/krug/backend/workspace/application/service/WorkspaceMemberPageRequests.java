package ru.krug.backend.workspace.application.service;

import java.util.Map;
import java.util.UUID;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.workspace.application.model.WorkspaceMemberPageCursor;

/**
 * Validation shared by the workspace member query: limit 1..100 (default 50), a literal
 * display-name search (case-insensitive substring) and an opaque workspace-bound cursor.
 */
public final class WorkspaceMemberPageRequests {

    public static final int DEFAULT_LIMIT = 50;
    public static final int MAX_LIMIT = 100;
    public static final int MAX_QUERY_LENGTH = 80;

    private WorkspaceMemberPageRequests() {
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
     * Normalises a literal substring search. Blank means "no filter"; an over-long query
     * is rejected instead of silently truncated. The database uses {@code position()},
     * never LIKE, so '%' and '_' are ordinary characters.
     */
    public static String query(String raw) {
        if (raw == null) {
            return null;
        }
        String normalized = raw.strip();
        if (normalized.length() > MAX_QUERY_LENGTH) {
            throw DomainException.badRequest(
                    "query must be at most " + MAX_QUERY_LENGTH + " characters",
                    Map.of("field", "query", "max", MAX_QUERY_LENGTH));
        }
        return normalized.isEmpty() ? null : normalized;
    }

    public static WorkspaceMemberPageCursor cursor(String raw, UUID workspaceId) {
        return raw == null || raw.isBlank()
                ? null
                : WorkspaceMemberPageCursor.decode(raw, workspaceId);
    }
}
