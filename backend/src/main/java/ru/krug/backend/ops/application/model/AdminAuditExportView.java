package ru.krug.backend.ops.application.model;

import java.util.List;

/**
 * Bounded platform-audit export (at most {@link #MAX_ROWS} rows). {@code truncated} means
 * more matching rows existed and the caller has to narrow the action filter.
 */
public record AdminAuditExportView(
        List<AdminAuditView> items,
        int exportedRows,
        boolean truncated) {

    public static final int MAX_ROWS = 10_000;
}
