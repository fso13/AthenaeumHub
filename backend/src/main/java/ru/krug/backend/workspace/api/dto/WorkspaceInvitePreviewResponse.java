package ru.krug.backend.workspace.api.dto;

import java.time.Instant;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * #100 anonymous invite preview: workspace/role/email-bound display metadata only. No
 * token, token hash or invited address is exposed.
 */
public record WorkspaceInvitePreviewResponse(
        @JsonProperty("workspace_name") String workspaceName,
        @JsonProperty("workspace_slug") String workspaceSlug,
        String role,
        @JsonProperty("email_bound") boolean emailBound,
        @JsonProperty("expires_at") Instant expiresAt) {
}
