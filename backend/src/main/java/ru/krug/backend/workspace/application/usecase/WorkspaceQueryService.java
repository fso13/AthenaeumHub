package ru.krug.backend.workspace.application.usecase;

import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.workspace.application.model.WorkspaceSummaryView;
import ru.krug.backend.workspace.domain.model.Membership;
import ru.krug.backend.workspace.domain.model.Workspace;
import ru.krug.backend.workspace.domain.repository.WorkspaceRepository;

@Service
public class WorkspaceQueryService {

    private final TenantContext tenantContext;
    private final WorkspaceRepository workspaceRepository;

    public WorkspaceQueryService(TenantContext tenantContext,
                                 WorkspaceRepository workspaceRepository) {
        this.tenantContext = tenantContext;
        this.workspaceRepository = workspaceRepository;
    }

    @Transactional(readOnly = true)
    public WorkspaceSummaryView findById(Principal principal, UUID workspaceId) {
        tenantContext.activate(principal.withWorkspace(workspaceId));
        Workspace workspace = workspaceRepository.findById(workspaceId)
                .orElseThrow(() -> DomainException.notFound("Workspace not found"));
        Membership membership = workspaceRepository.findMembership(workspaceId,
                        principal.userId())
                .filter(Membership::isActive)
                .orElseThrow(() -> DomainException.notFound("Workspace not found"));
        return new WorkspaceSummaryView(workspace.id(), workspace.name(), workspace.slug(),
                membership.role().name(), workspace.securityMode().name(),
                workspace.description(), workspace.logoFileId());
    }
}
