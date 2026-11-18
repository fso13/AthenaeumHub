package ru.krug.backend.ops.domain.model;

import java.time.Instant;
import java.util.UUID;

/**
 * One chat row of the platform-admin directory. {@code messagesCount} is the allocated
 * sequence count from {@code chat.chat_counters} (includes later-deleted messages); the
 * message timeline itself is never read.
 */
public record AdminChatRow(
        UUID id,
        String name,
        String type,
        String securityMode,
        UUID workspaceId,
        String workspaceName,
        long membersCount,
        long messagesCount,
        Instant createdAt,
        Instant lastActivityAt) {
}
