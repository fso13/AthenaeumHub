package ru.krug.backend.workspace.api.dto;

import jakarta.validation.constraints.Size;

/**
 * Request DTO for {@code PATCH /workspaces/{id}/dlp/policies/{policyId}}. Every field is
 * optional; at least one must be present (checked by the application).
 */
public record UpdateDlpPolicyRequest(
        @Size(max = 120) String name,
        @Size(max = 16) String action,
        @Size(max = 16) String patternType,
        @Size(max = 200) String pattern,
        Boolean enabled) {
}
