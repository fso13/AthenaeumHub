package ru.krug.backend.workspace.api.dto;

import java.util.List;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Size;

/** Partial matrix update; entries are applied atomically. */
public record UpdateWorkspacePermissionsRequest(
        @NotEmpty @Size(max = 18) List<@Valid WorkspacePermissionEntryRequest> entries) {
}
