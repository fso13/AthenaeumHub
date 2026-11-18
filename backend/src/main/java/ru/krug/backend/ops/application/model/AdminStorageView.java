package ru.krug.backend.ops.application.model;

import java.util.List;

/** Storage dashboard: totals plus the per-workspace rows they were summed from. */
public record AdminStorageView(
        AdminStorageTotalsView totals,
        List<AdminStorageWorkspaceView> workspaces) {
}
