package ru.krug.backend.ops.api.dto;

/** Response DTO for GET/PATCH /admin/settings (OpenAPI {@code AdminSettings}). */
public record AdminSettingsResponse(
        boolean setupCompleted,
        java.time.Instant setupCompletedAt,
        String smtpHost,
        Integer smtpPort,
        String smtpUsername,
        String smtpFrom,
        boolean smtpStarttls,
        boolean smtpConfigured,
        int maxChatsPerUser,
        int maxChatsPerWorkspace,
        int maxWorkspaceMembers,
        boolean registrationOpen,
        java.time.Instant updatedAt,
        java.util.UUID updatedBy) {
}
