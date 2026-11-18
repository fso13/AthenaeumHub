package ru.krug.backend.ops.application.model;

import java.time.Instant;
import java.util.UUID;

/** Secret-free read model of the installation settings. */
public record SystemSettingsView(
        Instant setupCompletedAt,
        SmtpSettingsView smtp,
        int maxChatsPerUser,
        int maxChatsPerWorkspace,
        int maxWorkspaceMembers,
        boolean registrationOpen,
        Instant updatedAt,
        UUID updatedBy) {

    public boolean setupCompleted() {
        return setupCompletedAt != null;
    }

    public boolean setupRequired() {
        return setupCompletedAt == null;
    }
}
