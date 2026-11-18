package ru.krug.backend.ops.api.dto;

import java.util.List;

/** Response DTO for {@code GET /admin/users} (contract {@code AdminUserPage}). */
public record AdminUserPageResponse(
        List<AdminUserResponse> items,
        String nextCursor,
        boolean hasMore) {
}
