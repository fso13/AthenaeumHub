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
import ru.krug.backend.workspace.application.service.WorkspaceLifecycleErrors;
import ru.krug.backend.workspace.domain.model.WorkspaceLeaveResult;
import ru.krug.backend.workspace.domain.repository.WorkspaceLifecycleRepository;

/**
 * {@code DELETE /workspaces/{workspaceId}/members/me} (#99): the caller leaves a workspace.
 *
 * <p>The membership and every chat participant row of the caller become {@code REMOVED}, so
 * the workspace disappears from {@code GET /me}, every workspace/chat session endpoint
 * re-evaluates the guard on the next request and the exact chat {@code member_count}
 * drops immediately. A member already removed by an administrator gets the same
 * idempotent {@code 204}. The last ACTIVE OWNER is refused with {@code 409 LAST_OWNER}
 * (the V2 schema allows exactly one OWNER, so an owner leaves only after a future
 * co-owner feature — the rule is still enforced from the live count).</p>
 *
 * <p>Access tokens are stateless and stay valid; they are not revoked globally because the
 * same Keycloak session may serve other workspaces. Authorization is re-checked against
 * the database on every request, which is the intended model. The audit event stores only
 * the caller id, role and the number of removed chat participant rows.</p>
 */
@Service
public class LeaveWorkspaceService {

    static final String ACTION = "workspace.member.left";

    private final TenantContext tenantContext;
    private final WorkspaceLifecycleRepository workspaces;
    private final AuditPort audit;
    private final ClockPort clock;

    public LeaveWorkspaceService(TenantContext tenantContext,
                                 WorkspaceLifecycleRepository workspaces,
                                 AuditPort audit, ClockPort clock) {
        this.tenantContext = tenantContext;
        this.workspaces = workspaces;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public void leave(Principal principal, UUID workspaceId) {
        tenantContext.activate(principal.withWorkspace(workspaceId));

        WorkspaceLeaveResult result = workspaces.leave(workspaceId, principal.userId());
        WorkspaceLifecycleErrors.throwIfFailed(result);
        if (result.outcome() != WorkspaceLeaveResult.Outcome.OK) {
            return;
        }

        audit.append(new AuditRecord(workspaceId, principal.userId(), ACTION, "user",
                principal.userId(), principal.requestId(),
                Map.of("role", result.role().name(),
                        "chat_memberships_removed", result.chatMembershipsRemoved()),
                clock.now()));
    }
}
