package ru.krug.backend.ops.api.dto;

import java.util.List;

/** Response DTO for {@code GET /admin/audit} (contract {@code AdminAuditPage}). */
public record AdminAuditPageResponse(
        List<AdminAuditEventResponse> items,
        String nextCursor,
        boolean hasMore) {
}
