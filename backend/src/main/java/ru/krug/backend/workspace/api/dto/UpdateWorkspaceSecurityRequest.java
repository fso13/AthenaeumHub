package ru.krug.backend.workspace.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;

/**
 * Request DTO for {@code PATCH /workspaces/{id}/security}. Every field is optional; at
 * least one must be present. {@code securityMode} is accepted only so an explicit mode
 * switch is rejected with {@code 422 MODE_CHANGE_FORBIDDEN}: the mode is immutable.
 */
public record UpdateWorkspaceSecurityRequest(
        @JsonProperty("require_2fa") Boolean requireTwoFactor,
        @Min(15) @Max(10080) Integer sessionTimeoutMinutes,
        Boolean dlpEnabled,
        @Min(1) @Max(3650) Integer retentionDays,
        String securityMode) {
}
