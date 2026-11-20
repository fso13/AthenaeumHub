package ru.krug.backend.workspace.api.dto;

import java.util.UUID;

import jakarta.validation.constraints.NotNull;

/** {@code POST /workspaces/{id}/avatar}: reference an existing CLEAN image attachment. */
public record WorkspaceAvatarRequest(@NotNull UUID fileId) {
}
