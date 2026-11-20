package ru.krug.backend.workspace.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;

/** Optional body for {@code POST /workspaces/{id}/invites}. */
public record WorkspaceInviteCreateRequest(
        @Size(max = 16) String role,
        @JsonProperty("max_uses") @Min(1) @Max(1000) Integer maxUses,
        @JsonProperty("expires_in_seconds") @Min(300) @Max(2592000) Long expiresInSeconds) {
}
