package ru.krug.backend.ops.application.model;

import java.time.Instant;
import java.util.UUID;

/** Read model of one admin chat row (metadata only, no timeline content). */
public record AdminChatView(
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
