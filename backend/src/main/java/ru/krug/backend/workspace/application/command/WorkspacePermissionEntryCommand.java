package ru.krug.backend.workspace.application.command;

/** One requested matrix cell. */
public record WorkspacePermissionEntryCommand(String role, String permission, boolean allowed) {
}
