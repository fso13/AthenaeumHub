package ru.krug.backend.ops.domain.model;

import java.time.Instant;
import java.util.UUID;

/**
 * One user row of the platform-admin directory. Metadata and aggregate counts only: no
 * message body, E2EE envelope or file content can be represented here.
 */
public record AdminUserRow(
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
