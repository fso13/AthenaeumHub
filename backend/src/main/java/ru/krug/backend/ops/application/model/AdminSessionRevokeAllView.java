package ru.krug.backend.ops.application.model;

/** Result of revoking every session of a platform-admin-selected user. */
public record AdminSessionRevokeAllView(int revokedSessions, int affectedUsers) {
}
