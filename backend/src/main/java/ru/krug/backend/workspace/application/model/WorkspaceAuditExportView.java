package ru.krug.backend.workspace.application.model;

import java.util.List;

/**
 * Bounded audit export (at most {@link #MAX_ROWS} rows). {@code truncated} is true when
 * more matching rows existed and the caller has to narrow the filters.
 */
public record WorkspaceAuditExportView(
        List<WorkspaceAuditView> items,
        int exportedRows,
        boolean truncated) {

    public static final int MAX_ROWS = 10_000;
}
