package ru.krug.backend.ops.application.model;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import ru.krug.backend.ops.domain.model.AdminAuditRow;

/** Domain row -> admin audit read model. No domain type crosses the API boundary. */
public final class AdminAuditViewMapper {

    private AdminAuditViewMapper() {
    }

    public static AdminAuditView toView(AdminAuditRow row) {
        return new AdminAuditView(row.id(), row.action(), row.actorId(), row.actorEmail(),
                row.targetType(), row.targetId(), row.createdAt());
    }

    public static List<AdminAuditView> toViews(List<AdminAuditRow> rows) {
        return rows.stream().map(AdminAuditViewMapper::toView).toList();
    }
}
