package ru.krug.backend.ops.api.dto;

/**
 * Response DTO for {@code POST /admin/users/{userId}/revoke-sessions} (contract
 * {@code AdminSessionRevokeAll}). Counts only; no session id is returned.
 */
public record AdminSessionRevokeAllResponse(int revokedSessions, int affectedUsers) {
}
