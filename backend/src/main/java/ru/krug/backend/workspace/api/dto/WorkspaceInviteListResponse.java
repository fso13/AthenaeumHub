package ru.krug.backend.workspace.api.dto;

import java.util.List;

public record WorkspaceInviteListResponse(List<WorkspaceInviteResponse> invites) {
}
