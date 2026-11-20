package ru.krug.backend.ops.api.mapper;

import java.util.List;

import ru.krug.backend.ops.api.dto.AdminAuditEventResponse;
import ru.krug.backend.ops.api.dto.AdminAuditExportResponse;
import ru.krug.backend.ops.application.model.AdminAuditExportView;
import ru.krug.backend.ops.application.model.AdminAuditView;

/**
 * Bounded platform-audit export rendering. CSV follows RFC 4180: a field is quoted only
 * when it contains a comma, quote, CR or LF, and an embedded quote is doubled. No metadata,
 * hash, request id or message/file content is included because the view carries none.
 */
public final class AdminAuditExportMapper {

    private static final String CSV_HEADER =
            "created_at,action,actor_id,actor_email,target_type,target_id";

    private AdminAuditExportMapper() {
    }

    public static AdminAuditExportResponse toResponse(AdminAuditExportView view) {
        return new AdminAuditExportResponse(view.items().stream()
                .map(AdminAuditExportMapper::toResponse).toList(),
                view.exportedRows(), view.truncated());
    }

    private static AdminAuditEventResponse toResponse(AdminAuditView view) {
        return new AdminAuditEventResponse(view.id(), view.action(), view.actorId(),
                view.actorEmail(), view.targetType(), view.targetId(), view.createdAt());
    }

    public static String toCsv(AdminAuditExportView view) {
        StringBuilder csv = new StringBuilder(CSV_HEADER).append('\n');
        for (AdminAuditView item : view.items()) {
            csv.append(csvCell(item.createdAt() == null ? null : item.createdAt().toString()))
                    .append(',')
                    .append(csvCell(item.action()))
                    .append(',')
                    .append(csvCell(item.actorId() == null ? null
                            : item.actorId().toString()))
                    .append(',')
                    .append(csvCell(item.actorEmail()))
                    .append(',')
                    .append(csvCell(item.targetType()))
                    .append(',')
                    .append(csvCell(item.targetId() == null ? null
                            : item.targetId().toString()))
                    .append('\n');
        }
        return csv.toString();
    }

    static String csvCell(String value) {
        if (value == null) {
            return "";
        }
        boolean quote = value.indexOf(',') >= 0 || value.indexOf('"') >= 0
                || value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0;
        if (!quote) {
            return value;
        }
        return "\"" + value.replace("\"", "\"\"") + "\"";
    }
}
