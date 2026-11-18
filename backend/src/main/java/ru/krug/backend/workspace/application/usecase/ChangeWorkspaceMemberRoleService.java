package ru.krug.backend.workspace.application.usecase;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.workspace.application.command.ChangeWorkspaceMemberRoleCommand;
import ru.krug.backend.workspace.application.model.WorkspaceMemberView;
import ru.krug.backend.workspace.application.service.WorkspaceMemberErrors;
import ru.krug.backend.workspace.application.service.WorkspaceMemberRequests;
import ru.krug.backend.workspace.domain.model.Membership;
import ru.krug.backend.workspace.domain.model.WorkspaceMemberMutation;
import ru.krug.backend.workspace.domain.repository.WorkspaceMemberManagementRepository;

/**
 * {@code PATCH /workspaces/{workspaceId}/members/{userId}} (FR-WS-6).
 *
 * <p>Authorization rules live in the SECURITY DEFINER function: OWNER may manage
 * ADMIN/MEMBER/GUEST, ADMIN only MEMBER/GUEST, OWNER is never assignable, the last owner and
 * self-changes are rejected. The audit event records previous/new roles only (no email or
 * display name) and is skipped for a no-op role change.</p>
 */
@Service
public class ChangeWorkspaceMemberRoleService {

    static final String ACTION = "workspace.member.role_changed";

    private final TenantContext tenantContext;
    private final WorkspaceMemberManagementRepository members;
    private final AuditPort audit;
    private final ClockPort clock;

    public ChangeWorkspaceMemberRoleService(TenantContext tenantContext,
                                            WorkspaceMemberManagementRepository members,
                                            AuditPort audit, ClockPort clock) {
        this.tenantContext = tenantContext;
        this.members = members;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public WorkspaceMemberView changeRole(Principal principal, UUID workspaceId,
                                          UUID targetUserId,
                                          ChangeWorkspaceMemberRoleCommand command) {
        Membership.Role role = WorkspaceMemberRequests.role(command.role());
        tenantContext.activate(principal.withWorkspace(workspaceId));

        WorkspaceMemberMutation result = members.changeRole(workspaceId, principal.userId(),
                targetUserId, role.name());
        WorkspaceMemberErrors.throwIfFailed(result);

        if (result.previousRole() != result.role()) {
            Map<String, Object> metadata = new LinkedHashMap<>();
            metadata.put("previous_role", result.previousRole().name());
            metadata.put("role", result.role().name());
            audit.append(new AuditRecord(workspaceId, principal.userId(), ACTION, "user",
                    result.userId(), principal.requestId(), metadata, clock.now()));
        }

        return AddWorkspaceMemberService.toView(result);
    }
}
