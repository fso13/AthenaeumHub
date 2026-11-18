package ru.krug.backend.workspace.api.dto;

import java.util.UUID;

/** Response DTO for POST /workspaces (OpenAPI {@code WorkspaceSummary}). */
public record WorkspaceSummaryResponse(
        UUID id,
        String name,
        String slug,
        String role,
        String securityMode) {
}
