package ru.krug.backend.workspace.application.command;

/**
 * {@code POST /workspaces/{id}/invites}; all fields optional. A non-blank {@code email}
 * creates a single-use email-bound invitation and forces {@code maxUses = 1}.
 */
public record WorkspaceInviteCreateCommand(String role, Integer maxUses,
                                           Long expiresInSeconds, String email) {

    public WorkspaceInviteCreateCommand(String role, Integer maxUses, Long expiresInSeconds) {
        this(role, maxUses, expiresInSeconds, null);
    }
}
