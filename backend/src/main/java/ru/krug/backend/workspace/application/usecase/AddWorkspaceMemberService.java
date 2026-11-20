package ru.krug.backend.workspace.application.usecase;

import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.chat.application.port.ChatChannelMembershipPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.workspace.application.command.AddWorkspaceMemberCommand;
import ru.krug.backend.workspace.application.model.WorkspaceMemberView;
import ru.krug.backend.workspace.application.service.WorkspaceMemberErrors;
import ru.krug.backend.workspace.application.service.WorkspaceMemberRequests;
import ru.krug.backend.workspace.domain.model.Membership;
import ru.krug.backend.workspace.domain.model.WorkspaceMemberMutation;
import ru.krug.backend.workspace.domain.repository.WorkspaceMemberManagementRepository;

/**
 * {@code POST /workspaces/{workspaceId}/members} (FR-WS-4/FR-WS-5): add an existing ACTIVE
 * user by email.
 *
 * <p>The application validates the transport shape (email, role literal) and the SQL
 * function owns authorization, the duplicate check and the atomic member-limit check. The
 * caller's role is therefore never trusted from the request, and a non-member/unknown
 * workspace answers {@code 403} without revealing existence.</p>
 *
 * <p>The audit event is appended in the same transaction and carries only the added user id
 * and role — never the email or display name.</p>
 */
@Service
public class AddWorkspaceMemberService {

    static final String ACTION = "workspace.member.added";

    private final TenantContext tenantContext;
    private final WorkspaceMemberManagementRepository members;
    private final ChatChannelMembershipPort channelMembership;
    private final AuditPort audit;
    private final ClockPort clock;

    public AddWorkspaceMemberService(TenantContext tenantContext,
                                     WorkspaceMemberManagementRepository members,
                                     ChatChannelMembershipPort channelMembership,
                                     AuditPort audit, ClockPort clock) {
        this.tenantContext = tenantContext;
        this.members = members;
        this.channelMembership = channelMembership;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public WorkspaceMemberView add(Principal principal, UUID workspaceId,
                                   AddWorkspaceMemberCommand command) {
        String email = WorkspaceMemberRequests.email(command.email());
        Membership.Role role = WorkspaceMemberRequests.role(command.role());
        tenantContext.activate(principal.withWorkspace(workspaceId));

        WorkspaceMemberMutation result = members.addMember(workspaceId, principal.userId(),
                email, role.name());
        WorkspaceMemberErrors.throwIfFailed(result);
        // PUBLIC channels are workspace-wide: a new ACTIVE member joins immediately.
        // PRIVATE channels are untouched (no invite links exist yet).
        channelMembership.joinPublicChannels(workspaceId, result.userId());

        audit.append(new AuditRecord(workspaceId, principal.userId(), ACTION, "user",
                result.userId(), principal.requestId(),
                Map.of("role", result.role().name()), clock.now()));

        return toView(result);
    }

    static WorkspaceMemberView toView(WorkspaceMemberMutation result) {
        return new WorkspaceMemberView(result.userId(), result.displayName(),
                result.role().name(), result.joinedAt());
    }
}
