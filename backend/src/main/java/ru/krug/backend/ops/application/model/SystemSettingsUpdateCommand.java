package ru.krug.backend.ops.application.model;

/**
 * Patch command for {@code PATCH /admin/settings}. {@code null} means "leave unchanged";
 * an empty SMTP password also means "leave unchanged" (it cannot be read back).
 */
public record SystemSettingsUpdateCommand(
        String smtpHost,
        Integer smtpPort,
        String smtpUsername,
        String smtpPassword,
        String smtpFrom,
        Boolean smtpStarttls,
        Integer maxChatsPerUser,
        Integer maxChatsPerWorkspace,
        Integer maxWorkspaceMembers,
        Boolean registrationOpen,
        Boolean completeSetup,
        Boolean setupCompleted) {
}
