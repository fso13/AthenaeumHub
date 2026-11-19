package ru.krug.backend.file.api.dto;

import java.util.List;

/** OpenAPI {@code FilePage}: one stable page of file-center metadata plus quota. */
public record FilePageResponse(
        List<FileItemResponse> items,
        PageInfo page,
        FileQuotaSummaryResponse quota) {

    public record PageInfo(String nextCursor, boolean hasMore) {
    }
}
