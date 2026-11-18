package ru.krug.backend.ops.application.usecase;

import java.util.List;
import java.util.Map;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.auth.application.usecase.PlatformAdminGuard;
import ru.krug.backend.ops.application.model.AdminAuditPageView;
import ru.krug.backend.ops.application.model.AdminAuditView;
import ru.krug.backend.ops.application.model.AdminAuditViewMapper;
import ru.krug.backend.ops.application.model.AdminPageCursor;
import ru.krug.backend.ops.application.service.AdminPageRequests;
import ru.krug.backend.ops.domain.model.AdminAuditRow;
import ru.krug.backend.ops.domain.repository.AdminActionRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;

/**
 * {@code GET /admin/audit} (FR-ADM-17): cross-tenant cursor page over the append-only audit
 * trail, optionally filtered by an exact action name.
 *
 * <p>The read goes through {@code ops.admin_audit_page} because {@code audit.audit_events}
 * is tenant-RLS-scoped. The function returns only the contract columns — metadata JSONB,
 * hashes and request ids never leave the database — so no message/file/secret body can leak
 * even if a future audit event stores richer metadata. The page read itself is audited with
 * counts only, consistently with the other admin lists.</p>
 */
@Service
public class ListAdminAuditService {

    static final int MAX_ACTION_LENGTH = 120;
    static final String ACTION = "admin.audit.viewed";

    private final PlatformAdminGuard adminGuard;
    private final AdminActionRepository actions;
    private final AuditPort audit;
    private final ClockPort clock;

    public ListAdminAuditService(PlatformAdminGuard adminGuard,
                                 AdminActionRepository actions,
                                 AuditPort audit,
                                 ClockPort clock) {
        this.adminGuard = adminGuard;
        this.actions = actions;
        this.audit = audit;
        this.clock = clock;
    }

    // Not readOnly: appending the access audit event is part of the same transaction.
    @Transactional
    public AdminAuditPageView list(Principal principal, String action, String cursor,
                                   Integer requestedLimit) {
        adminGuard.require(principal);
        int limit = AdminPageRequests.limit(requestedLimit);
        String actionFilter = AdminPageRequests.action(action, MAX_ACTION_LENGTH);
        AdminPageCursor decoded = AdminPageRequests.cursor(cursor, AdminPageCursor.SCOPE_AUDIT);

        List<AdminAuditRow> rows = actions.findAuditEvents(actionFilter,
                decoded == null ? null : decoded.createdAt(),
                decoded == null ? null : decoded.id(), limit + 1);
        boolean hasMore = rows.size() > limit;
        List<AdminAuditRow> page = hasMore ? rows.subList(0, limit) : rows;

        String nextCursor = null;
        if (hasMore && !page.isEmpty()) {
            AdminAuditRow last = page.get(page.size() - 1);
            nextCursor = new AdminPageCursor(AdminPageCursor.SCOPE_AUDIT, last.createdAt(),
                    last.id()).encode();
        }
        List<AdminAuditView> items = AdminAuditViewMapper.toViews(page);

        audit.append(new AuditRecord(null, principal.userId(), ACTION, "admin_audit", null,
                principal.requestId(),
                Map.of("returned", items.size(), "has_more", hasMore), clock.now()));
        return new AdminAuditPageView(items, nextCursor, hasMore);
    }
}
