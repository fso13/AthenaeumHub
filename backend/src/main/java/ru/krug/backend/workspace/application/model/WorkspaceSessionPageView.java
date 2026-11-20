package ru.krug.backend.workspace.application.model;

import java.util.List;

/** Cursor page of workspace member sessions. */
public record WorkspaceSessionPageView(
        List<WorkspaceSessionView> items,
        String nextCursor,
        boolean hasMore) {
}
