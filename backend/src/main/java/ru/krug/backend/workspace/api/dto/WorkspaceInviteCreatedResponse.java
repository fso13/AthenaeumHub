package ru.krug.backend.workspace.api.dto;

/** Create response: raw token and accept URL are returned exactly once. */
public record WorkspaceInviteCreatedResponse(WorkspaceInviteResponse invite, String token,
                                             String acceptUrl) {
}
