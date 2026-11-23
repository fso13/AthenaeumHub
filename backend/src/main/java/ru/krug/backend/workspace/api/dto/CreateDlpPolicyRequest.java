package ru.krug.backend.workspace.api.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;

/**
 * Request DTO for {@code POST /workspaces/{id}/dlp/policies}. The action/type/scope
 * literals and the bounded literal pattern are additionally validated in the application
 * layer so the error carries the contract's field names.
 *
 * <p>{@code scope} is optional (default {@code ALL}); {@code max_file_size_bytes} is an
 * optional attachment-only threshold.</p>
 */
public record CreateDlpPolicyRequest(
        @NotBlank @Size(max = 120) String name,
        @NotBlank @Size(max = 16) String action,
        @NotBlank @Size(max = 16) String patternType,
        @NotBlank @Size(max = 200) String pattern,
        @Size(max = 16) String scope,
        @Positive Long maxFileSizeBytes,
        Boolean enabled) {
}
