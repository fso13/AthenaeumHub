package ru.krug.backend.workspace.api.dto;

import java.util.List;

/** Cursor page of DLP decision events (contract {@code DlpEventPage}). */
public record DlpEventPageResponse(
        List<DlpEventResponse> items,
        String nextCursor,
        boolean hasMore) {
}
