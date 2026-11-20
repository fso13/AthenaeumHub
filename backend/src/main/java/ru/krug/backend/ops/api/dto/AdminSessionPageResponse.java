package ru.krug.backend.ops.api.dto;

import java.util.List;

/** Response DTO for {@code GET /admin/sessions} (contract {@code AdminSessionPage}). */
public record AdminSessionPageResponse(
        List<AdminSessionResponse> items,
        String nextCursor,
        boolean hasMore) {
}
