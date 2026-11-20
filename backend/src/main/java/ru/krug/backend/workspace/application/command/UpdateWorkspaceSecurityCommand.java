package ru.krug.backend.workspace.application.command;

/**
 * Partial workspace security-settings update. {@code securityMode} is accepted by the
 * transport only to reject an explicit mode-switch attempt: the mode itself is immutable
 * and is never written by this command.
 */
public record UpdateWorkspaceSecurityCommand(
        Boolean requireTwoFactor,
        Integer sessionTimeoutMinutes,
        Boolean dlpEnabled,
        Integer retentionDays,
        String securityMode) {

    public boolean isEmpty() {
        return requireTwoFactor == null && sessionTimeoutMinutes == null && dlpEnabled == null
                && retentionDays == null && securityMode == null;
    }
}
