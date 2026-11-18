package ru.krug.backend.workspace.application.model;

import java.util.List;

/** One cursor page of the workspace member directory (contract {@code WorkspaceMemberPage}). */
public record WorkspaceMemberPageView(
        List<WorkspaceMemberView> items,
        String nextCursor,
        boolean hasMore) {

    public WorkspaceMemberPageView {
        items = items == null ? List.of() : List.copyOf(items);
    }
}
