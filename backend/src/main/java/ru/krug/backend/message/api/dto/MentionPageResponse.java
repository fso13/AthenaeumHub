package ru.krug.backend.message.api.dto;

import java.util.List;

/** OpenAPI {@code MentionPage}. */
public record MentionPageResponse(
        List<MentionResponse> items,
        Page page,
        long unreadCount) {

    public record Page(String nextCursor, boolean hasMore) {
    }
}
