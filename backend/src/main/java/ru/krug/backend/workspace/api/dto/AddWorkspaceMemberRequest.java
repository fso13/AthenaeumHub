package ru.krug.backend.workspace.api.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * {@code POST /workspaces/{workspaceId}/members}. Only an existing ACTIVE account can be
 * added; {@code role=OWNER} is rejected by the service with {@code 403
 * ROLE_CHANGE_FORBIDDEN} because the workspace has exactly one immutable owner.
 */
public record AddWorkspaceMemberRequest(
        @NotBlank @Email @Size(max = 254) String email,
        @NotNull @Pattern(regexp = "OWNER|ADMIN|MEMBER|GUEST",
                message = "must be OWNER, ADMIN, MEMBER or GUEST") String role) {
}
