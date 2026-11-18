package ru.krug.backend.ops.application.usecase;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.auth.application.usecase.PlatformAdminGuard;
import ru.krug.backend.ops.application.model.AdminStorageTotalsView;
import ru.krug.backend.ops.application.model.AdminStorageView;
import ru.krug.backend.ops.application.model.AdminStorageWorkspaceView;
import ru.krug.backend.ops.application.service.AdminDirectoryViewMapper;
import ru.krug.backend.ops.domain.model.AdminStorageWorkspaceRow;
import ru.krug.backend.ops.domain.repository.AdminDirectoryRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;

/**
 * {@code GET /admin/storage}: installation storage totals and per-workspace rows
 * (FR-ADM-12). Totals are the sum of the returned rows, so a workspace filter yields that
 * workspace's totals. Only quota aggregates and counts are exposed; filenames, object keys
 * and bytes never cross this boundary. The audit event contains counts only.
 */
@Service
public class GetAdminStorageService {

    static final String ACTION = "admin.storage.viewed";

    private final PlatformAdminGuard adminGuard;
    private final AdminDirectoryRepository directory;
    private final AuditPort audit;
    private final ClockPort clock;

    public GetAdminStorageService(PlatformAdminGuard adminGuard,
                                  AdminDirectoryRepository directory,
                                  AuditPort audit,
                                  ClockPort clock) {
        this.adminGuard = adminGuard;
        this.directory = directory;
        this.audit = audit;
        this.clock = clock;
    }

    // Not readOnly: appending the access audit event is part of the same transaction.
    @Transactional
    public AdminStorageView storage(Principal principal, UUID workspaceId) {
        adminGuard.require(principal);
        List<AdminStorageWorkspaceRow> rows = directory.findStorageWorkspaces(workspaceId);

        long usedBytes = 0;
        long reservedBytes = 0;
        long objects = 0;
        long attachments = 0;
        for (AdminStorageWorkspaceRow row : rows) {
            usedBytes += row.usedBytes();
            reservedBytes += row.reservedBytes();
            objects += row.objects();
            attachments += row.attachments();
        }
        List<AdminStorageWorkspaceView> workspaces = rows.stream()
                .map(AdminDirectoryViewMapper::toView).toList();

        audit.append(new AuditRecord(null, principal.userId(), ACTION, "admin_storage", null,
                principal.requestId(),
                Map.of("workspaces", workspaces.size(),
                        "used_bytes", usedBytes,
                        "reserved_bytes", reservedBytes,
                        "objects", objects,
                        "attachments", attachments),
                clock.now()));
        return new AdminStorageView(
                new AdminStorageTotalsView(usedBytes, reservedBytes, objects, attachments),
                workspaces);
    }
}
