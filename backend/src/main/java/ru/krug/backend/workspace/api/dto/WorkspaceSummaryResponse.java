package ru.krug.backend.workspace.api.dto;

import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonProperty;

/** Response DTO for workspace create/update (OpenAPI {@code WorkspaceSummary}). */
public record WorkspaceSummaryResponse(
        UUID id,
        String name,
        String slug,
        String role,
        @JsonProperty("security_mode") String securityMode,
        String description,
        @JsonProperty("logo_file_id") UUID logoFileId) {
}
