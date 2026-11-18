package ru.krug.backend.workspace.api.dto;

import java.util.List;

/** Response DTO for {@code GET /workspaces/{workspaceId}/members}. */
public record WorkspaceMemberPageResponse(
        List<WorkspaceMemberResponse> items,
        String nextCursor,
        boolean hasMore) {
}
