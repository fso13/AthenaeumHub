package ru.krug.backend.workspace.application.usecase;

import java.util.List;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.workspace.application.model.WorkspaceMembershipView;
import ru.krug.backend.workspace.application.port.WorkspaceDirectoryPort;
import ru.krug.backend.workspace.domain.model.WorkspaceMembership;
import ru.krug.backend.workspace.domain.repository.WorkspaceRepository;

/**
 * RLS context is activated by the caller (MeQueryService) in the same transaction; this
 * service only maps workspace-owned rows into an application read model.
 */
@Service
public class WorkspaceDirectoryService implements WorkspaceDirectoryPort {

    private final WorkspaceRepository workspaceRepository;

    public WorkspaceDirectoryService(WorkspaceRepository workspaceRepository) {
        this.workspaceRepository = workspaceRepository;
    }

    @Override
    @Transactional(readOnly = true)
    public List<WorkspaceMembershipView> listActiveMemberships(UUID userId) {
        return workspaceRepository.listActiveMemberships(userId).stream()
                .map(WorkspaceDirectoryService::toView)
                .toList();
    }

    private static WorkspaceMembershipView toView(WorkspaceMembership item) {
        return new WorkspaceMembershipView(item.workspace().id(), item.workspace().name(),
                item.workspace().slug(), item.membership().role().name(),
                item.workspace().securityMode().name());
    }
}
