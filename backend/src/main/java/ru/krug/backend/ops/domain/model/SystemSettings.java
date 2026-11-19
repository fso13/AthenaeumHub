package ru.krug.backend.ops.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

import ru.krug.backend.shared.domain.model.AllowedFileExtensions;

/**
 * Installation-wide runtime settings (R-03/R-04). Exactly one row exists; the defaults are
 * the v1.1 business parameters. The aggregate is pure domain code and never exposes the
 * SMTP plaintext password.
 */
public record SystemSettings(
        Instant setupCompletedAt,
        SmtpSettings smtp,
        AllowedFileExtensions allowedFileExtensions,
        int maxChatsPerUser,
        int maxChatsPerWorkspace,
        int maxWorkspaceMembers,
        boolean registrationOpen,
        Instant updatedAt,
        UUID updatedBy) {

    public static final int DEFAULT_MAX_CHATS_PER_USER = 100;
    public static final int DEFAULT_MAX_CHATS_PER_WORKSPACE = 1000;
    public static final int DEFAULT_MAX_WORKSPACE_MEMBERS = 100;

    public SystemSettings {
        smtp = Objects.requireNonNull(smtp, "smtp");
        allowedFileExtensions = allowedFileExtensions == null
                ? AllowedFileExtensions.defaults() : allowedFileExtensions;
        requireLimit(maxChatsPerUser, "maxChatsPerUser");
        requireLimit(maxChatsPerWorkspace, "maxChatsPerWorkspace");
        requireLimit(maxWorkspaceMembers, "maxWorkspaceMembers");
    }

    public static SystemSettings defaults(Instant now) {
        return new SystemSettings(null, SmtpSettings.empty(), AllowedFileExtensions.defaults(),
                DEFAULT_MAX_CHATS_PER_USER, DEFAULT_MAX_CHATS_PER_WORKSPACE,
                DEFAULT_MAX_WORKSPACE_MEMBERS, true, now, null);
    }

    public boolean setupCompleted() {
        return setupCompletedAt != null;
    }

    public boolean setupRequired() {
        return setupCompletedAt == null;
    }

    public boolean smtpConfigured() {
        return smtp.configured();
    }

    public SystemSettings completeSetup(Instant completedAt, UUID actor) {
        if (setupCompleted()) {
            throw new IllegalStateException("Setup is already completed");
        }
        return new SystemSettings(Objects.requireNonNull(completedAt, "completedAt"), smtp,
                allowedFileExtensions, maxChatsPerUser, maxChatsPerWorkspace,
                maxWorkspaceMembers, registrationOpen, completedAt, actor);
    }

    public SystemSettings updated(Instant now, UUID actor) {
        return new SystemSettings(setupCompletedAt, smtp, allowedFileExtensions,
                maxChatsPerUser, maxChatsPerWorkspace, maxWorkspaceMembers, registrationOpen,
                now, actor);
    }

    private static void requireLimit(int value, String name) {
        if (value < 1 || value > 1_000_000) {
            throw new IllegalArgumentException(name + " must be within 1..1000000");
        }
    }
}
