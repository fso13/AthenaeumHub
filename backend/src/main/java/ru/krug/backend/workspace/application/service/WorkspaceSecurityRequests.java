package ru.krug.backend.workspace.application.service;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.workspace.application.model.AuditExportFormat;
import ru.krug.backend.workspace.application.model.WorkspaceSecurityCursor;
import ru.krug.backend.workspace.domain.model.WorkspaceSecuritySettings;

/**
 * Shared validation for the workspace security surface: page limits, exact action / time
 * filters, opaque workspace-bound cursors, the audit export format and the security
 * settings bounds. Inputs are never silently truncated.
 */
public final class WorkspaceSecurityRequests {

    public static final int DEFAULT_AUDIT_LIMIT = 30;
    public static final int DEFAULT_SESSION_LIMIT = 50;
    public static final int MAX_LIMIT = 100;
    public static final int MAX_ACTION_LENGTH = 120;
    public static final int MAX_SESSION_ID_LENGTH = 128;

    private WorkspaceSecurityRequests() {
    }

    public static int limit(Integer requested, int defaultLimit) {
        int limit = requested == null ? defaultLimit : requested;
        if (limit < 1 || limit > MAX_LIMIT) {
            throw DomainException.badRequest("limit must be between 1 and " + MAX_LIMIT,
                    Map.of("field", "limit", "min", 1, "max", MAX_LIMIT));
        }
        return limit;
    }

    public static String action(String raw) {
        if (raw == null) {
            return null;
        }
        String value = raw.strip();
        if (value.length() > MAX_ACTION_LENGTH) {
            throw DomainException.badRequest(
                    "action must be at most " + MAX_ACTION_LENGTH + " characters",
                    Map.of("field", "action", "max", MAX_ACTION_LENGTH));
        }
        return value.isEmpty() ? null : value;
    }

    public static Instant timeRangeStart(Instant from, Instant to) {
        if (from != null && to != null && from.isAfter(to)) {
            throw DomainException.badRequest("from must not be after to",
                    Map.of("field", "from"));
        }
        return from;
    }

    public static WorkspaceSecurityCursor cursor(String raw, String scope, UUID workspaceId) {
        return raw == null || raw.isBlank()
                ? null
                : WorkspaceSecurityCursor.decode(raw, scope, workspaceId);
    }

    public static String sessionId(String raw) {
        if (raw == null) {
            throw DomainException.badRequest("sessionId is required",
                    Map.of("field", "sessionId"));
        }
        String value = raw.strip();
        if (value.isEmpty() || value.length() > MAX_SESSION_ID_LENGTH) {
            throw DomainException.badRequest(
                    "sessionId must be between 1 and " + MAX_SESSION_ID_LENGTH + " characters",
                    Map.of("field", "sessionId", "max", MAX_SESSION_ID_LENGTH));
        }
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character < 0x20 || character == 0x7F) {
                throw DomainException.badRequest("sessionId must not contain control characters",
                        Map.of("field", "sessionId"));
            }
        }
        return value;
    }

    public static AuditExportFormat exportFormat(String raw) {
        AuditExportFormat format = AuditExportFormat.parse(raw);
        if (format == null) {
            throw DomainException.badRequest("format must be csv or json",
                    Map.of("field", "format", "allowed", java.util.List.of("csv", "json")));
        }
        return format;
    }

    public static int sessionTimeoutMinutes(int value) {
        if (value < WorkspaceSecuritySettings.MIN_SESSION_TIMEOUT_MINUTES
                || value > WorkspaceSecuritySettings.MAX_SESSION_TIMEOUT_MINUTES) {
            throw DomainException.badRequest(
                    "session_timeout_minutes must be between "
                            + WorkspaceSecuritySettings.MIN_SESSION_TIMEOUT_MINUTES + " and "
                            + WorkspaceSecuritySettings.MAX_SESSION_TIMEOUT_MINUTES,
                    Map.of("field", "session_timeout_minutes",
                            "min", WorkspaceSecuritySettings.MIN_SESSION_TIMEOUT_MINUTES,
                            "max", WorkspaceSecuritySettings.MAX_SESSION_TIMEOUT_MINUTES));
        }
        return value;
    }

    public static int retentionDays(int value) {
        if (value < WorkspaceSecuritySettings.MIN_RETENTION_DAYS
                || value > WorkspaceSecuritySettings.MAX_RETENTION_DAYS) {
            throw DomainException.badRequest(
                    "retention_days must be between "
                            + WorkspaceSecuritySettings.MIN_RETENTION_DAYS + " and "
                            + WorkspaceSecuritySettings.MAX_RETENTION_DAYS,
                    Map.of("field", "retention_days",
                            "min", WorkspaceSecuritySettings.MIN_RETENTION_DAYS,
                            "max", WorkspaceSecuritySettings.MAX_RETENTION_DAYS));
        }
        return value;
    }
}
