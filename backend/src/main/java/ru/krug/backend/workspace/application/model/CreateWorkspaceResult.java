package ru.krug.backend.workspace.application.model;

import java.util.UUID;

public record CreateWorkspaceResult(int status, WorkspaceSummaryView workspace, boolean replay) {
}
