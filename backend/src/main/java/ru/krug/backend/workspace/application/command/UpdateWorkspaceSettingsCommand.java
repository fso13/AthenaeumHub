package ru.krug.backend.workspace.application.command;

import java.util.UUID;

/** Partial {@code PATCH /workspaces/{id}}; presence flags distinguish keep from clear. */
public record UpdateWorkspaceSettingsCommand(
        boolean namePresent,
        String name,
        boolean descriptionPresent,
        String description,
        boolean logoPresent,
        UUID logoFileId) {

    public boolean isEmpty() {
        return !namePresent && !descriptionPresent && !logoPresent;
    }
}
