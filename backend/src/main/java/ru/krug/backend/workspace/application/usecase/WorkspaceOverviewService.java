package ru.krug.backend.workspace.application.usecase;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.workspace.application.model.WorkspaceOverviewView;
import ru.krug.backend.workspace.application.model.WorkspaceAuditView;
import ru.krug.backend.workspace.application.port.WorkspacePresencePort;
import ru.krug.backend.workspace.domain.model.Membership;
import ru.krug.backend.workspace.domain.model.Workspace;
import ru.krug.backend.workspace.domain.model.WorkspaceAuditEvent;
import ru.krug.backend.workspace.domain.model.WorkspaceOverviewStats;
import ru.krug.backend.workspace.domain.repository.WorkspaceAuditRepository;
import ru.krug.backend.workspace.domain.repository.WorkspaceOverviewRepository;
import ru.krug.backend.workspace.domain.repository.WorkspaceRepository;

/**
 * {@code GET /workspaces/{id}/overview} (#84).
 *
 * <p>Any ACTIVE member of an ACTIVE workspace can read the aggregate dashboard. The tenant
 * context is activated before the read, so RLS scopes every repository, and the V49 SQL
 * function re-checks membership. Only counts, byte totals and the storage quota are
 * returned. The five recent audit rows are an OWNER/ADMIN preview; a regular member gets an
 * empty list and {@code workspace.audit_page} would return no rows for them anyway. Presence
 * is the live single-node realtime signal and is clamped to the member total.</p>
 */
@Service
public class WorkspaceOverviewService {

    private static final int AUDIT_PREVIEW_LIMIT = 5;

    private final TenantContext tenantContext;
    private final WorkspaceRepository workspaceRepository;
    private final WorkspaceOverviewRepository overviewRepository;
    private final WorkspaceAuditRepository auditRepository;
    private final WorkspacePresencePort presence;
    private final ClockPort clock;

    public WorkspaceOverviewService(TenantContext tenantContext,
                                    WorkspaceRepository workspaceRepository,
                                    WorkspaceOverviewRepository overviewRepository,
                                    WorkspaceAuditRepository auditRepository,
                                    WorkspacePresencePort presence, ClockPort clock) {
        this.tenantContext = tenantContext;
        this.workspaceRepository = workspaceRepository;
        this.overviewRepository = overviewRepository;
        this.auditRepository = auditRepository;
        this.presence = presence;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public WorkspaceOverviewView overview(Principal principal, UUID workspaceId) {
        if (principal == null || workspaceId == null) {
            throw DomainException.forbidden("No access to this workspace");
        }
        tenantContext.activate(principal.withWorkspace(workspaceId));
        Workspace workspace = workspaceRepository.findById(workspaceId)
                .filter(value -> value.status() == Workspace.Status.ACTIVE)
                .orElseThrow(WorkspaceOverviewService::noAccess);
        Membership membership = workspaceRepository.findMembership(workspaceId,
                        principal.userId())
                .filter(Membership::isActive)
                .orElseThrow(WorkspaceOverviewService::noAccess);

        Instant now = clock.now();
        WorkspaceOverviewStats stats = overviewRepository.stats(workspaceId,
                        principal.userId(), now)
                .orElseThrow(WorkspaceOverviewService::noAccess);
        long online = Math.min(stats.membersTotal(),
                Math.max(0, presence.onlineMemberCount(workspace.id())));
        List<WorkspaceAuditView> auditRecent = auditPreview(principal, workspaceId, membership);

        return new WorkspaceOverviewView(stats.membersTotal(), online, stats.chatsTotal(),
                stats.messagesTotal(), stats.messagesLast24h(), stats.filesTotal(),
                stats.filesUsedBytes(), stats.filesReservedBytes(), stats.dlpEventsLast24h(),
                stats.storageQuotaBytes(), auditRecent, now);
    }

    private List<WorkspaceAuditView> auditPreview(Principal principal, UUID workspaceId,
                                                  Membership membership) {
        if (membership.role() != Membership.Role.OWNER
                && membership.role() != Membership.Role.ADMIN) {
            return List.of();
        }
        List<WorkspaceAuditEvent> rows = auditRepository.page(workspaceId, principal.userId(),
                null, null, null, null, null, null, AUDIT_PREVIEW_LIMIT);
        return rows.stream().map(WorkspaceOverviewService::view).toList();
    }

    private static WorkspaceAuditView view(WorkspaceAuditEvent event) {
        return new WorkspaceAuditView(event.id(), event.action(), event.actorId(),
                event.targetType(), event.targetId(), event.createdAt());
    }

    private static DomainException noAccess() {
        return DomainException.forbidden("No access to this workspace");
    }
}
