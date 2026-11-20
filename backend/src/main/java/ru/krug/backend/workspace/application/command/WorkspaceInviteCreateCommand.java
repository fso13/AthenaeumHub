package ru.krug.backend.workspace.application.command;

/** {@code POST /workspaces/{id}/invites}; all fields optional. */
public record WorkspaceInviteCreateCommand(String role, Integer maxUses,
                                           Long expiresInSeconds) {
}
