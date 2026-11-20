package ru.krug.backend.workspace.api.dto;

import java.util.List;

/** JSON body of the bounded audit export (contract {@code WorkspaceAuditExport}). */
public record WorkspaceAuditExportResponse(
        List<WorkspaceAuditEventResponse> items,
        int exportedRows,
        boolean truncated) {
}
