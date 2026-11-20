package ru.krug.backend.workspace.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * Workspace security policy values (P0-3). The workspace {@code security_mode} is not
 * stored here: it stays immutable on {@link Workspace} and is never changed by this
 * settings surface.
 */
public record WorkspaceSecuritySettings(
        UUID workspaceId,
        boolean requireTwoFactor,
        int sessionTimeoutMinutes,
        boolean dlpEnabled,
        int retentionDays,
        Instant updatedAt,
        UUID updatedBy) {

    public static final int MIN_SESSION_TIMEOUT_MINUTES = 15;
    public static final int MAX_SESSION_TIMEOUT_MINUTES = 10080;
    public static final int MIN_RETENTION_DAYS = 1;
    public static final int MAX_RETENTION_DAYS = 3650;

    public WorkspaceSecuritySettings {
        Objects.requireNonNull(workspaceId, "workspaceId");
        Objects.requireNonNull(updatedAt, "updatedAt");
    }

    public WorkspaceSecuritySettings with(boolean newRequireTwoFactor,
                                          int newSessionTimeoutMinutes,
                                          boolean newDlpEnabled, int newRetentionDays,
                                          Instant now, UUID actorId) {
        return new WorkspaceSecuritySettings(workspaceId, newRequireTwoFactor,
                newSessionTimeoutMinutes, newDlpEnabled, newRetentionDays, now, actorId);
    }
}
