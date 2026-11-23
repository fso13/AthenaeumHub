package ru.krug.backend.workspace.api.mapper;

import ru.krug.backend.workspace.api.dto.WorkspaceInviteAcceptanceResponse;
import ru.krug.backend.workspace.api.dto.WorkspaceInviteCreatedResponse;
import ru.krug.backend.workspace.api.dto.WorkspaceInviteListResponse;
import ru.krug.backend.workspace.api.dto.WorkspaceInvitePreviewResponse;
import ru.krug.backend.workspace.api.dto.WorkspaceInviteResponse;
import ru.krug.backend.workspace.api.dto.WorkspaceMemberPageResponse;
import ru.krug.backend.workspace.api.dto.WorkspaceMemberResponse;
import ru.krug.backend.workspace.api.dto.WorkspaceSummaryResponse;
import ru.krug.backend.workspace.application.model.WorkspaceInviteAcceptanceView;
import ru.krug.backend.workspace.application.model.WorkspaceInviteCreatedView;
import ru.krug.backend.workspace.application.model.WorkspaceInvitePreviewView;
import ru.krug.backend.workspace.application.model.WorkspaceInviteView;
import ru.krug.backend.workspace.application.model.WorkspaceMemberPageView;
import ru.krug.backend.workspace.application.model.WorkspaceMemberView;
import ru.krug.backend.workspace.application.model.WorkspaceSummaryView;

public final class WorkspaceApiMapper {

    private WorkspaceApiMapper() {
    }

    public static WorkspaceSummaryResponse toResponse(WorkspaceSummaryView view) {
        return new WorkspaceSummaryResponse(view.id(), view.name(), view.slug(), view.role(),
                view.securityMode(), view.description(), view.logoFileId());
    }

    public static WorkspaceMemberPageResponse toResponse(WorkspaceMemberPageView view) {
        return new WorkspaceMemberPageResponse(view.items().stream()
                .map(WorkspaceApiMapper::toResponse)
                .toList(), view.nextCursor(), view.hasMore());
    }

    public static WorkspaceInviteListResponse toResponse(java.util.List<WorkspaceInviteView> views) {
        return new WorkspaceInviteListResponse(views.stream()
                .map(WorkspaceApiMapper::toResponse)
                .toList());
    }

    public static WorkspaceInviteResponse toResponse(WorkspaceInviteView view) {
        return new WorkspaceInviteResponse(view.id(), view.role(), view.status(),
                view.usedCount(), view.maxUses(), view.expiresAt(), view.createdAt(),
                view.createdBy(), view.email());
    }

    public static WorkspaceInvitePreviewResponse toResponse(WorkspaceInvitePreviewView view) {
        return new WorkspaceInvitePreviewResponse(view.workspaceName(), view.workspaceSlug(),
                view.role(), view.emailBound(), view.expiresAt());
    }

    public static WorkspaceInviteCreatedResponse toResponse(WorkspaceInviteCreatedView view) {
        return new WorkspaceInviteCreatedResponse(toResponse(view.invite()), view.token(),
                view.acceptUrl());
    }

    public static WorkspaceInviteAcceptanceResponse toResponse(
            WorkspaceInviteAcceptanceView view) {
        return new WorkspaceInviteAcceptanceResponse(view.workspaceId(), view.workspaceName(),
                view.workspaceSlug(), view.role(), view.alreadyMember());
    }

    public static WorkspaceMemberResponse toResponse(WorkspaceMemberView view) {
        return new WorkspaceMemberResponse(view.userId(), view.displayName(), view.role(),
                view.joinedAt());
    }
}
