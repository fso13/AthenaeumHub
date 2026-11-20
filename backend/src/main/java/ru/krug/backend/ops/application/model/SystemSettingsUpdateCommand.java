package ru.krug.backend.ops.application.model;

import java.util.List;

/**
 * Patch command for {@code PATCH /admin/settings}. {@code null} means "leave unchanged";
 * an empty SMTP password also means "leave unchanged" (it cannot be read back). An empty
 * {@code allowedFileExtensions} list is invalid (1..100 entries).
 */
public record SystemSettingsUpdateCommand(
        String smtpHost,
        Integer smtpPort,
        String smtpUsername,
        String smtpPassword,
        String smtpFrom,
        Boolean smtpStarttls,
        List<String> allowedFileExtensions,
        Integer maxChatsPerUser,
        Integer maxChatsPerWorkspace,
        Integer maxWorkspaceMembers,
        Boolean registrationOpen,
        Boolean requireTwoFactor,
        Boolean completeSetup,
        Boolean setupCompleted) {
}
