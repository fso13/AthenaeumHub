package ru.krug.backend.workspace.application.usecase;

import java.util.UUID;

import org.springframework.stereotype.Service;

import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.workspace.application.model.WorkspaceSecurityContext;
import ru.krug.backend.workspace.domain.model.Membership;
import ru.krug.backend.workspace.domain.model.Workspace;
import ru.krug.backend.workspace.domain.repository.WorkspaceRepository;

/**
 * Authorization gate for the P0-3 workspace security surface. Every DLP, audit, session
 * and security-settings operation calls this first: the caller must be an ACTIVE
 * OWNER/ADMIN of an ACTIVE workspace. A non-member and a foreign workspace answer the
 * same {@code 403}, so workspace existence is not disclosed. The tenant context is bound
 * before the repository read, so RLS also scopes the row. The caller owns the transaction:
 * the GUC is transaction-local, so this method must run inside the service transaction.
 */
@Service
public class WorkspaceSecurityGuard {

    private final TenantContext tenantContext;
    private final WorkspaceRepository workspaceRepository;

    public WorkspaceSecurityGuard(TenantContext tenantContext,
                                  WorkspaceRepository workspaceRepository) {
        this.tenantContext = tenantContext;
        this.workspaceRepository = workspaceRepository;
    }

    public WorkspaceSecurityContext requireManager(Principal principal, UUID workspaceId) {
        if (principal == null || workspaceId == null) {
            throw DomainException.forbidden("No access to this workspace");
        }
        tenantContext.activate(principal.withWorkspace(workspaceId));
        Workspace workspace = workspaceRepository.findById(workspaceId)
                .filter(value -> value.status() == Workspace.Status.ACTIVE)
                .orElseThrow(() -> DomainException.forbidden("No access to this workspace"));
        Membership membership = workspaceRepository.findMembership(workspaceId,
                        principal.userId())
                .filter(Membership::isActive)
                .orElseThrow(() -> DomainException.forbidden("No access to this workspace"));
        if (membership.role() != Membership.Role.OWNER
                && membership.role() != Membership.Role.ADMIN) {
            throw DomainException.forbidden(
                    "Workspace OWNER or ADMIN role is required");
        }
        return new WorkspaceSecurityContext(workspace.id(), workspace.securityMode().name());
    }
}
