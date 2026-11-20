package ru.krug.backend.workspace.api.mapper;

import ru.krug.backend.workspace.api.dto.WorkspaceAuditEventResponse;
import ru.krug.backend.workspace.api.dto.WorkspaceOverviewResponse;
import ru.krug.backend.workspace.application.model.WorkspaceAuditView;
import ru.krug.backend.workspace.application.model.WorkspaceOverviewView;

/** Workspace overview read model -> API DTO. No domain type crosses this boundary. */
public final class WorkspaceOverviewApiMapper {

    private WorkspaceOverviewApiMapper() {
    }

    public static WorkspaceOverviewResponse toResponse(WorkspaceOverviewView view) {
        return new WorkspaceOverviewResponse(
                new WorkspaceOverviewResponse.Members(view.membersTotal(), view.membersOnline()),
                view.chatsTotal(),
                new WorkspaceOverviewResponse.Messages(view.messagesTotal(),
                        view.messagesLast24h()),
                new WorkspaceOverviewResponse.Files(view.filesTotal(), view.filesUsedBytes(),
                        view.filesReservedBytes()),
                new WorkspaceOverviewResponse.Dlp(view.dlpEventsLast24h()),
                new WorkspaceOverviewResponse.Storage(view.filesUsedBytes(),
                        view.storageQuotaBytes()),
                view.auditRecent().stream().map(WorkspaceOverviewApiMapper::toAudit).toList(),
                view.generatedAt());
    }

    private static WorkspaceAuditEventResponse toAudit(WorkspaceAuditView view) {
        return new WorkspaceAuditEventResponse(view.id(), view.action(), view.actorId(),
                view.targetType(), view.targetId(), view.createdAt());
    }
}
