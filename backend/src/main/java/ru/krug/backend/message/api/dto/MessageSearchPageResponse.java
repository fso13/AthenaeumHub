package ru.krug.backend.message.api.dto;

import java.util.List;

/** OpenAPI {@code MessageSearchPage}. */
public record MessageSearchPageResponse(
        List<MessageSearchHitResponse> items,
        Page page,
        String query) {

    public record Page(String nextCursor, boolean hasMore) {
    }
}
