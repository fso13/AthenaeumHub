package ru.krug.backend.workspace.application.usecase;

import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.workspace.application.service.WorkspaceMemberErrors;
import ru.krug.backend.workspace.domain.model.WorkspaceMemberMutation;
import ru.krug.backend.workspace.domain.repository.WorkspaceMemberManagementRepository;

/**
 * {@code DELETE /workspaces/{workspaceId}/members/{userId}} (FR-WS-6/FR-WS-7).
 *
 * <p>Removal is soft ({@code status = 'REMOVED'}): the membership row and {@code joined_at}
 * are kept, but every access guard checks {@code ACTIVE}. The removed user therefore loses
 * workspace/chat access on the next request; existing access tokens are not revoked, which
 * is intentional (stateless JWT, authorization is re-evaluated per request).</p>
 *
 * <p>The audit event carries only the target user id and the role at removal time.</p>
 */
@Service
public class RemoveWorkspaceMemberService {

    static final String ACTION = "workspace.member.removed";

    private final TenantContext tenantContext;
    private final WorkspaceMemberManagementRepository members;
    private final AuditPort audit;
    private final ClockPort clock;

    public RemoveWorkspaceMemberService(TenantContext tenantContext,
                                        WorkspaceMemberManagementRepository members,
                                        AuditPort audit, ClockPort clock) {
        this.tenantContext = tenantContext;
        this.members = members;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public void remove(Principal principal, UUID workspaceId, UUID targetUserId) {
        tenantContext.activate(principal.withWorkspace(workspaceId));

        WorkspaceMemberMutation result = members.removeMember(workspaceId,
                principal.userId(), targetUserId);
        WorkspaceMemberErrors.throwIfFailed(result);

        audit.append(new AuditRecord(workspaceId, principal.userId(), ACTION, "user",
                result.userId(), principal.requestId(),
                Map.of("role", result.role().name()), clock.now()));
    }
}
