package ru.krug.backend.workspace.application.model;

import java.util.List;

/** Cursor page of the workspace audit view. */
public record WorkspaceAuditPageView(
        List<WorkspaceAuditView> items,
        String nextCursor,
        boolean hasMore) {
}
