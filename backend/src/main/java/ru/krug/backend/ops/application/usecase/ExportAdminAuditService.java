package ru.krug.backend.ops.application.usecase;

import java.util.List;
import java.util.Map;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.auth.application.usecase.PlatformAdminGuard;
import ru.krug.backend.ops.application.model.AdminAuditExportView;
import ru.krug.backend.ops.application.model.AdminAuditView;
import ru.krug.backend.ops.application.model.AdminAuditViewMapper;
import ru.krug.backend.ops.application.model.AdminExportFormat;
import ru.krug.backend.ops.application.service.AdminPageRequests;
import ru.krug.backend.ops.domain.model.AdminAuditRow;
import ru.krug.backend.ops.domain.repository.AdminActionRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;

/**
 * {@code GET /admin/audit/export?format=csv|json} (#84): bounded platform-audit export.
 *
 * <p>The read goes through {@code ops.admin_audit_export}, which re-checks the
 * platform-admin caller and returns the seven contract columns only. Metadata JSONB, hash
 * chain bytes and request ids never leave the database. At most 10 000 rows are returned
 * and truncation is reported; the export itself is audited with counters only.</p>
 */
@Service
public class ExportAdminAuditService {

    static final String ACTION = "admin.audit.exported";
    private static final int MAX_ACTION_LENGTH = 120;

    private final PlatformAdminGuard adminGuard;
    private final AdminActionRepository actions;
    private final AuditPort audit;
    private final ClockPort clock;

    public ExportAdminAuditService(PlatformAdminGuard adminGuard,
                                   AdminActionRepository actions, AuditPort audit,
                                   ClockPort clock) {
        this.adminGuard = adminGuard;
        this.actions = actions;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public AdminAuditExportView export(Principal principal, String action, String rawFormat) {
        adminGuard.require(principal);
        AdminExportFormat format = AdminExportFormat.parse(rawFormat);
        if (format == null) {
            throw DomainException.badRequest("format must be csv or json",
                    Map.of("field", "format", "allowed", List.of("csv", "json")));
        }
        String actionFilter = AdminPageRequests.action(action, MAX_ACTION_LENGTH);

        List<AdminAuditRow> rows = actions.findAuditEventsForExport(actionFilter,
                AdminAuditExportView.MAX_ROWS + 1);
        boolean truncated = rows.size() > AdminAuditExportView.MAX_ROWS;
        if (truncated) {
            rows = rows.subList(0, AdminAuditExportView.MAX_ROWS);
        }
        List<AdminAuditView> items = AdminAuditViewMapper.toViews(rows);

        audit.append(new AuditRecord(null, principal.userId(), ACTION, "admin_audit", null,
                principal.requestId(),
                Map.of("format", format.name(), "returned", items.size(),
                        "truncated", truncated),
                clock.now()));
        return new AdminAuditExportView(items, items.size(), truncated);
    }
}
