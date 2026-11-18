package ru.krug.backend.workspace.application.command;

/** {@code POST /workspaces/{workspaceId}/members}; only an existing account can be added. */
public record AddWorkspaceMemberCommand(String email, String role) {
}
