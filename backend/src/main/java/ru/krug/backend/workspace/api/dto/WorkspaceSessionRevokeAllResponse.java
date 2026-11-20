package ru.krug.backend.workspace.api.dto;

/** Result of {@code POST /workspaces/{id}/sessions/revoke-all} (contract). */
public record WorkspaceSessionRevokeAllResponse(int revokedSessions, int affectedUsers) {
}
