package ru.krug.backend.workspace.application.usecase;

import java.util.List;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.workspace.application.model.WorkspaceMemberPageCursor;
import ru.krug.backend.workspace.application.model.WorkspaceMemberPageView;
import ru.krug.backend.workspace.application.model.WorkspaceMemberView;
import ru.krug.backend.workspace.application.port.WorkspaceAccessPort;
import ru.krug.backend.workspace.application.service.WorkspaceMemberPageRequests;
import ru.krug.backend.workspace.domain.model.WorkspaceMemberRow;
import ru.krug.backend.workspace.domain.repository.WorkspaceMemberRepository;

/**
 * {@code GET /workspaces/{workspaceId}/members}: active members for the DIRECT-chat peer
 * picker. The caller must be an ACTIVE member of the workspace (403 otherwise, including
 * a foreign/unknown workspace — existence is not disclosed). The V24 function enforces the
 * same rule in SQL, so a guard bypass still yields no rows. A page is one query
 * (limit + 1 rows, no N+1); {@code has_more} is derived from the extra row.
 */
@Service
public class ListWorkspaceMembersService {

    private final TenantContext tenantContext;
    private final WorkspaceAccessPort workspaceAccess;
    private final WorkspaceMemberRepository members;

    public ListWorkspaceMembersService(TenantContext tenantContext,
                                       WorkspaceAccessPort workspaceAccess,
                                       WorkspaceMemberRepository members) {
        this.tenantContext = tenantContext;
        this.workspaceAccess = workspaceAccess;
        this.members = members;
    }

    @Transactional(readOnly = true)
    public WorkspaceMemberPageView list(Principal principal, UUID workspaceId, String query,
                                        String cursor, Integer requestedLimit) {
        tenantContext.activate(principal.withWorkspace(workspaceId));
        workspaceAccess.requireActiveMember(workspaceId, principal.userId());

        int limit = WorkspaceMemberPageRequests.limit(requestedLimit);
        String search = WorkspaceMemberPageRequests.query(query);
        WorkspaceMemberPageCursor decoded = WorkspaceMemberPageRequests.cursor(cursor,
                workspaceId);

        List<WorkspaceMemberRow> rows = members.findActiveMembers(workspaceId, search,
                decoded == null ? null : decoded.displayName(),
                decoded == null ? null : decoded.userId(), limit + 1);
        boolean hasMore = rows.size() > limit;
        List<WorkspaceMemberRow> page = hasMore ? rows.subList(0, limit) : rows;

        String nextCursor = null;
        if (hasMore && !page.isEmpty()) {
            WorkspaceMemberRow last = page.get(page.size() - 1);
            nextCursor = new WorkspaceMemberPageCursor(workspaceId, last.displayName(),
                    last.userId()).encode();
        }
        List<WorkspaceMemberView> items = page.stream()
                .map(ListWorkspaceMembersService::toView)
                .toList();
        return new WorkspaceMemberPageView(items, nextCursor, hasMore);
    }

    private static WorkspaceMemberView toView(WorkspaceMemberRow row) {
        return new WorkspaceMemberView(row.userId(), row.displayName(), row.role(),
                row.joinedAt());
    }
}
