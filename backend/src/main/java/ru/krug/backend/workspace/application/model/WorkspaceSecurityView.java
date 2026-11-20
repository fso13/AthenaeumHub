package ru.krug.backend.workspace.application.model;

import java.time.Instant;

/**
 * Workspace security policy values. The workspace {@code security_mode} is intentionally
 * absent: it is immutable and this surface never changes it.
 */
public record WorkspaceSecurityView(
        boolean requireTwoFactor,
        int sessionTimeoutMinutes,
        boolean dlpEnabled,
        int retentionDays,
        Instant updatedAt) {
}
