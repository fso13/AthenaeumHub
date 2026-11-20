package ru.krug.backend.workspace.application.usecase;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.workspace.application.model.AuditExportFormat;
import ru.krug.backend.workspace.application.model.WorkspaceAuditExportView;
import ru.krug.backend.workspace.application.model.WorkspaceAuditFilter;
import ru.krug.backend.workspace.application.model.WorkspaceAuditPageView;
import ru.krug.backend.workspace.application.model.WorkspaceAuditView;
import ru.krug.backend.workspace.application.model.WorkspaceSecurityCursor;
import ru.krug.backend.workspace.application.service.WorkspaceSecurityActions;
import ru.krug.backend.workspace.application.service.WorkspaceSecurityRequests;
import ru.krug.backend.workspace.domain.exception.InvalidWorkspaceSecurityCursorException;
import ru.krug.backend.workspace.domain.model.WorkspaceAuditEvent;
import ru.krug.backend.workspace.domain.repository.WorkspaceAuditRepository;

/**
 * {@code GET /workspaces/{id}/audit} and {@code .../audit/export} (P0-3). OWNER/ADMIN
 * only; the SQL function re-checks the role. The response carries action/actor/target/time
 * only — metadata JSONB, hash-chain bytes, request id and actor email never leave the
 * database. The export is bounded to {@link WorkspaceAuditExportView#MAX_ROWS} rows and
 * reports truncation; exporting is itself audited with counts only.
 */
@Service
public class WorkspaceAuditService {

    private static final String TARGET_TYPE = "workspace_audit";

    private final WorkspaceSecurityGuard guard;
    private final WorkspaceAuditRepository auditRepository;
    private final AuditPort audit;
    private final ClockPort clock;

    public WorkspaceAuditService(WorkspaceSecurityGuard guard,
                                 WorkspaceAuditRepository auditRepository,
                                 AuditPort audit, ClockPort clock) {
        this.guard = guard;
        this.auditRepository = auditRepository;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public WorkspaceAuditPageView list(Principal principal, UUID workspaceId, String action,
                                       UUID actorId, Instant from, Instant to, String cursor,
                                       Integer requestedLimit) {
        guard.requireManager(principal, workspaceId);
        WorkspaceAuditFilter filter = filter(action, actorId, from, to);
        int limit = WorkspaceSecurityRequests.limit(requestedLimit,
                WorkspaceSecurityRequests.DEFAULT_AUDIT_LIMIT);
        WorkspaceSecurityCursor decoded = WorkspaceSecurityRequests.cursor(cursor,
                WorkspaceSecurityCursor.SCOPE_AUDIT, workspaceId);

        List<WorkspaceAuditEvent> rows = auditRepository.page(workspaceId, principal.userId(),
                filter.action(), filter.actorId(), filter.from(), filter.to(),
                decoded == null ? null : decoded.at(), cursorId(decoded), limit + 1);
        boolean hasMore = rows.size() > limit;
        List<WorkspaceAuditEvent> page = hasMore ? rows.subList(0, limit) : rows;

        String nextCursor = null;
        if (hasMore && !page.isEmpty()) {
            WorkspaceAuditEvent last = page.get(page.size() - 1);
            nextCursor = new WorkspaceSecurityCursor(WorkspaceSecurityCursor.SCOPE_AUDIT,
                    workspaceId, last.createdAt(), last.id().toString()).encode();
        }
        return new WorkspaceAuditPageView(page.stream().map(WorkspaceAuditService::view).toList(),
                nextCursor, hasMore);
    }

    @Transactional
    public WorkspaceAuditExportView export(Principal principal, UUID workspaceId, String action,
                                           UUID actorId, Instant from, Instant to,
                                           String requestedFormat) {
        guard.requireManager(principal, workspaceId);
        AuditExportFormat format = WorkspaceSecurityRequests.exportFormat(requestedFormat);
        WorkspaceAuditFilter filter = filter(action, actorId, from, to);

        // One probe row beyond the cap tells us whether the result was truncated.
        List<WorkspaceAuditEvent> rows = auditRepository.page(workspaceId, principal.userId(),
                filter.action(), filter.actorId(), filter.from(), filter.to(), null, null,
                WorkspaceAuditExportView.MAX_ROWS + 1);
        boolean truncated = rows.size() > WorkspaceAuditExportView.MAX_ROWS;
        if (truncated) {
            rows = rows.subList(0, WorkspaceAuditExportView.MAX_ROWS);
        }
        List<WorkspaceAuditView> items = rows.stream().map(WorkspaceAuditService::view).toList();

        audit.append(new AuditRecord(workspaceId, principal.userId(),
                WorkspaceSecurityActions.AUDIT_EXPORTED, TARGET_TYPE, null,
                principal.requestId(),
                Map.of("format", format.name(), "returned", items.size(),
                        "truncated", truncated),
                clock.now()));
        return new WorkspaceAuditExportView(items, items.size(), truncated);
    }

    private static WorkspaceAuditFilter filter(String action, UUID actorId, Instant from,
                                               Instant to) {
        WorkspaceSecurityRequests.timeRangeStart(from, to);
        return new WorkspaceAuditFilter(WorkspaceSecurityRequests.action(action), actorId,
                from, to);
    }

    private static UUID cursorId(WorkspaceSecurityCursor cursor) {
        if (cursor == null) {
            return null;
        }
        try {
            return UUID.fromString(cursor.key());
        } catch (IllegalArgumentException ex) {
            throw new InvalidWorkspaceSecurityCursorException();
        }
    }

    private static WorkspaceAuditView view(WorkspaceAuditEvent event) {
        return new WorkspaceAuditView(event.id(), event.action(), event.actorId(),
                event.targetType(), event.targetId(), event.createdAt());
    }
}
