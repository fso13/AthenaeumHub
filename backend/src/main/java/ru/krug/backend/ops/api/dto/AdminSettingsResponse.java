package ru.krug.backend.ops.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

/**
 * Response DTO for GET/PATCH /admin/settings (OpenAPI {@code AdminSettings}). The file
 * extension allowlist is normalized and lower-case; it is not a secret.
 */
public record AdminSettingsResponse(
        boolean setupCompleted,
        java.time.Instant setupCompletedAt,
        String smtpHost,
        Integer smtpPort,
        String smtpUsername,
        String smtpFrom,
        boolean smtpStarttls,
        boolean smtpConfigured,
        List<String> allowedFileExtensions,
        int maxChatsPerUser,
        int maxChatsPerWorkspace,
        int maxWorkspaceMembers,
        boolean registrationOpen,
        @JsonProperty("require_2fa") boolean requireTwoFactor,
        java.time.Instant updatedAt,
        java.util.UUID updatedBy) {
}
