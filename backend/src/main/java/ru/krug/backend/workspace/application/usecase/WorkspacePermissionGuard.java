package ru.krug.backend.workspace.application.usecase;

import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;

import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.workspace.application.model.WorkspaceAccessContext;
import ru.krug.backend.workspace.domain.model.Membership;
import ru.krug.backend.workspace.domain.model.Workspace;
import ru.krug.backend.workspace.domain.model.WorkspacePermission;
import ru.krug.backend.workspace.domain.repository.WorkspacePermissionRepository;
import ru.krug.backend.workspace.domain.repository.WorkspaceRepository;

/**
 * Authorization gate for the P0-4 workspace surface. The caller must be an ACTIVE member of
 * an ACTIVE workspace; the effective role matrix then decides the requested action.
 *
 * <p>A non-member and a foreign workspace answer the same {@code 403}, so workspace
 * existence is not disclosed. The tenant context is bound before any repository read, so
 * RLS also scopes the rows. The caller owns the transaction: the GUC is
 * transaction-local.</p>
 */
@Service
public class WorkspacePermissionGuard {

    private final TenantContext tenantContext;
    private final WorkspaceRepository workspaces;
    private final WorkspacePermissionRepository permissions;

    public WorkspacePermissionGuard(TenantContext tenantContext, WorkspaceRepository workspaces,
                                    WorkspacePermissionRepository permissions) {
        this.tenantContext = tenantContext;
        this.workspaces = workspaces;
        this.permissions = permissions;
    }

    /** Any ACTIVE member; used by the read-only matrix endpoint. */
    public WorkspaceAccessContext requireMember(Principal principal, UUID workspaceId) {
        if (principal == null || workspaceId == null || principal.userId() == null) {
            throw noAccess();
        }
        tenantContext.activate(principal.withWorkspace(workspaceId));
        Workspace workspace = workspaces.findById(workspaceId)
                .filter(value -> value.status() == Workspace.Status.ACTIVE)
                .orElseThrow(WorkspacePermissionGuard::noAccess);
        Membership membership = workspaces.findMembership(workspaceId, principal.userId())
                .filter(Membership::isActive)
                .orElseThrow(WorkspacePermissionGuard::noAccess);
        return new WorkspaceAccessContext(workspace, membership);
    }

    public WorkspaceAccessContext requirePermission(Principal principal, UUID workspaceId,
                                                    WorkspacePermission permission) {
        WorkspaceAccessContext context = requireMember(principal, workspaceId);
        if (!isAllowed(context, permission)) {
            throw DomainException.forbidden(ErrorCode.WORKSPACE_PERMISSION_DENIED,
                    "The workspace role does not grant this permission",
                    Map.of("permission", permission.apiName()));
        }
        return context;
    }

    public boolean isAllowed(WorkspaceAccessContext context, WorkspacePermission permission) {
        if (context.role() == Membership.Role.OWNER) {
            return true;
        }
        return permissions.isAllowed(context.workspace().id(), context.role(), permission);
    }

    private static DomainException noAccess() {
        return DomainException.forbidden("No access to this workspace");
    }
}
