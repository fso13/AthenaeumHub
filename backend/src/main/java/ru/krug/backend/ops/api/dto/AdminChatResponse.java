package ru.krug.backend.ops.api.dto;

import java.time.Instant;
import java.util.UUID;

/** Response DTO for one admin chat row (contract {@code AdminChat}). */
public record AdminChatResponse(
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
