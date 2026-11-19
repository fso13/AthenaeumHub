package ru.krug.backend.file.application.model;

import java.util.List;

/** One page of the workspace file center plus the optional quota summary. */
public record FilePageView(
        List<FileItemView> items,
        String nextCursor,
        boolean hasMore,
        FileQuotaSummaryView quota) {

    public FilePageView {
        items = items == null ? List.of() : List.copyOf(items);
    }
}
