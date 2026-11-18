package ru.krug.backend.workspace.api.mapper;

import ru.krug.backend.workspace.api.dto.WorkspaceMemberPageResponse;
import ru.krug.backend.workspace.api.dto.WorkspaceMemberResponse;
import ru.krug.backend.workspace.api.dto.WorkspaceSummaryResponse;
import ru.krug.backend.workspace.application.model.WorkspaceMemberPageView;
import ru.krug.backend.workspace.application.model.WorkspaceMemberView;
import ru.krug.backend.workspace.application.model.WorkspaceSummaryView;

public final class WorkspaceApiMapper {

    private WorkspaceApiMapper() {
    }

    public static WorkspaceSummaryResponse toResponse(WorkspaceSummaryView view) {
        return new WorkspaceSummaryResponse(view.id(), view.name(), view.slug(), view.role(),
                view.securityMode());
    }

    public static WorkspaceMemberPageResponse toResponse(WorkspaceMemberPageView view) {
        return new WorkspaceMemberPageResponse(view.items().stream()
                .map(WorkspaceApiMapper::toResponse)
                .toList(), view.nextCursor(), view.hasMore());
    }

    public static WorkspaceMemberResponse toResponse(WorkspaceMemberView view) {
        return new WorkspaceMemberResponse(view.userId(), view.displayName(), view.role(),
                view.joinedAt());
    }
}
