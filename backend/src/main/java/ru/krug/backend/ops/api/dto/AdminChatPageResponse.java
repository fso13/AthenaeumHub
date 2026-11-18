package ru.krug.backend.ops.api.dto;

import java.util.List;

/** Response DTO for {@code GET /admin/chats} (contract {@code AdminChatPage}). */
public record AdminChatPageResponse(
        List<AdminChatResponse> items,
        String nextCursor,
        boolean hasMore) {
}
