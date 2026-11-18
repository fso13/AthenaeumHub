package ru.krug.backend.workspace.application.command;

/** {@code PATCH /workspaces/{workspaceId}/members/{userId}}. */
public record ChangeWorkspaceMemberRoleCommand(String role) {
}
