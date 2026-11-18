package ru.krug.backend.ops.application.model;

import java.time.Instant;
import java.util.UUID;

/** Read model of one admin user row (metadata + aggregates only). */
public record AdminUserView(
        UUID id,
        String email,
        String displayName,
        boolean platformAdmin,
        String status,
        long workspacesCount,
        long chatsCount,
        long storageUsedBytes,
        Instant createdAt) {
}
