package ru.krug.backend.ops.api.dto;

/** Response DTO for GET /admin/overview. */
public record AdminOverviewResponse(long users, long workspaces, long chats) {
}
