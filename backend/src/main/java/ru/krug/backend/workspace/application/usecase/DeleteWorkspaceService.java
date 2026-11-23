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
import ru.krug.backend.workspace.domain.model.WorkspaceDeletionResult;
import ru.krug.backend.workspace.domain.repository.WorkspaceLifecycleRepository;

/**
 * {@code DELETE /workspaces/{workspaceId}} (#99): the OWNER soft-deletes the workspace.
 *
 * <p>The V55 function sets {@code status = 'DELETED'} and {@code deleted_at/deleted_by},
 * removes every membership, revokes every invite, removes every chat participant row and
 * disables every bot. Message rows, attachment rows and object-storage bytes are
 * deliberately retained for the later retention/export job; they are unreachable through
 * the API because every guard requires an ACTIVE membership.</p>
 *
 * <p>The call is idempotent for the owner: a repeat answers {@code 204} without a second
 * audit event. Any other caller (member, admin or outsider) receives {@code 403} and cannot
 * probe whether the workspace ever existed. Stateless access tokens are not revoked
 * globally (a Keycloak session may serve other workspaces); every workspace, chat, file
 * and session endpoint re-checks the database on the next request. The audit event carries
 * ids and counters only, never names or content.</p>
 */
@Service
public class DeleteWorkspaceService {

    static final String ACTION = "workspace.deleted";

    private final TenantContext tenantContext;
    private final WorkspaceLifecycleRepository workspaces;
    private final AuditPort audit;
    private final ClockPort clock;

    public DeleteWorkspaceService(TenantContext tenantContext,
                                  WorkspaceLifecycleRepository workspaces,
                                  AuditPort audit, ClockPort clock) {
        this.tenantContext = tenantContext;
        this.workspaces = workspaces;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public void delete(Principal principal, UUID workspaceId) {
        tenantContext.activate(principal.withWorkspace(workspaceId));

        WorkspaceDeletionResult result = workspaces.delete(workspaceId, principal.userId());
        WorkspaceLifecycleErrors.throwIfFailed(result);
        if (result.outcome() != WorkspaceDeletionResult.Outcome.OK) {
            return;
        }

        audit.append(new AuditRecord(workspaceId, principal.userId(), ACTION, "workspace",
                workspaceId, principal.requestId(),
                Map.of("memberships_removed", result.membershipsRemoved(),
                        "invites_revoked", result.invitesRevoked(),
                        "chat_memberships_removed", result.chatMembershipsRemoved(),
                        "bots_disabled", result.botsDisabled()),
                clock.now()));
    }
}
