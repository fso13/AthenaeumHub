package ru.krug.backend.ops.application.model;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** Secret-free read model of the installation settings. */
public record SystemSettingsView(
        Instant setupCompletedAt,
        SmtpSettingsView smtp,
        List<String> allowedFileExtensions,
        int maxChatsPerUser,
        int maxChatsPerWorkspace,
        int maxWorkspaceMembers,
        boolean registrationOpen,
        Instant updatedAt,
        UUID updatedBy) {

    public SystemSettingsView {
        allowedFileExtensions = allowedFileExtensions == null ? List.of()
                : List.copyOf(allowedFileExtensions);
    }

    public boolean setupCompleted() {
        return setupCompletedAt != null;
    }

    public boolean setupRequired() {
        return setupCompletedAt == null;
    }
}
