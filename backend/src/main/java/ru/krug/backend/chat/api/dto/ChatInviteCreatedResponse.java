package ru.krug.backend.chat.api.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * OpenAPI {@code ChatInviteCreated} (#79). {@code token} is returned exactly once and is not
 * recoverable afterwards (only its SHA-256 hash is stored).
 */
public record ChatInviteCreatedResponse(
        UUID id,
        String role,
        String status,
        int usedCount,
        Integer maxUses,
        Instant expiresAt,
        Instant createdAt,
        UUID createdBy,
        String token) {
}
