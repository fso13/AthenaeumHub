package ru.krug.backend.workspace.api.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/** One matrix cell in {@code PATCH .../permissions}. */
public record WorkspacePermissionEntryRequest(
        @NotBlank @Size(max = 16) String role,
        @NotBlank @Size(max = 40) String permission,
        @NotNull Boolean allowed) {
}
