package ru.krug.backend.workspace.application.model;

import java.util.List;

/** Cursor page of DLP decision events. */
public record DlpEventPageView(List<DlpEventView> items, String nextCursor, boolean hasMore) {
}
