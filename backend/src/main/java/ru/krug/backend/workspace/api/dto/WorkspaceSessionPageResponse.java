package ru.krug.backend.workspace.api.dto;

import java.util.List;

/** Cursor page of workspace member sessions (contract {@code WorkspaceSessionPage}). */
public record WorkspaceSessionPageResponse(
        List<WorkspaceSessionResponse> items,
        String nextCursor,
        boolean hasMore) {
}
