package ru.krug.backend.workspace.api.dto;

import java.util.List;

/** Cursor page of the workspace audit view (contract {@code WorkspaceAuditPage}). */
public record WorkspaceAuditPageResponse(
        List<WorkspaceAuditEventResponse> items,
        String nextCursor,
        boolean hasMore) {
}
