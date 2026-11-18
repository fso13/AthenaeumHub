package ru.krug.backend.workspace.api.dto;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;

/** {@code PATCH /workspaces/{workspaceId}/members/{userId}}. */
public record ChangeWorkspaceMemberRoleRequest(
        @NotNull @Pattern(regexp = "OWNER|ADMIN|MEMBER|GUEST",
                message = "must be OWNER, ADMIN, MEMBER or GUEST") String role) {
}
