package ru.krug.backend.workspace.application.command;

import java.util.UUID;

public record DevWorkspaceCommand(UUID workspaceId, UUID ownerId, String name, String slug) {
}
