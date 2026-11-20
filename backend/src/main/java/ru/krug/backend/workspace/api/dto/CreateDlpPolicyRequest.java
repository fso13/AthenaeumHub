package ru.krug.backend.workspace.api.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Request DTO for {@code POST /workspaces/{id}/dlp/policies}. The action/type literals and
 * the bounded literal pattern are additionally validated in the application layer so the
 * error carries the contract's field names.
 */
public record CreateDlpPolicyRequest(
        @NotBlank @Size(max = 120) String name,
        @NotBlank @Size(max = 16) String action,
        @NotBlank @Size(max = 16) String patternType,
        @NotBlank @Size(max = 200) String pattern,
        Boolean enabled) {
}
