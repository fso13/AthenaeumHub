package ru.krug.backend.workspace.application.model;

/** Result of {@code POST /workspaces/{id}/sessions/revoke-all}. */
public record WorkspaceSessionRevokeAllView(int revokedSessions, int affectedUsers) {
}
