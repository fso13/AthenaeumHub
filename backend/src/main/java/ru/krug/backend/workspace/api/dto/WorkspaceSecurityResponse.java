package ru.krug.backend.workspace.api.dto;

import java.time.Instant;

import com.fasterxml.jackson.annotation.JsonProperty;

/** Response DTO for {@code GET/PATCH /workspaces/{id}/security}. */
public record WorkspaceSecurityResponse(
        @JsonProperty("require_2fa") boolean requireTwoFactor,
        int sessionTimeoutMinutes,
        boolean dlpEnabled,
        int retentionDays,
        Instant updatedAt) {
}
