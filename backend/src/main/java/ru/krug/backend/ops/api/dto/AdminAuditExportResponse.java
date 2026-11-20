package ru.krug.backend.ops.api.dto;

import java.util.List;

/** JSON body of the bounded platform-audit export (contract {@code AdminAuditExport}). */
public record AdminAuditExportResponse(
        List<AdminAuditEventResponse> items,
        int exportedRows,
        boolean truncated) {
}
