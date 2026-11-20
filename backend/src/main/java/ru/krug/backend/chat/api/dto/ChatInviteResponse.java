package ru.krug.backend.chat.api.dto;

import java.time.Instant;
import java.util.UUID;

/** OpenAPI {@code ChatInvite} (#79) — metadata only, never the token or its hash. */
public record ChatInviteResponse(
        UUID id,
        String role,
        String status,
        int usedCount,
        Integer maxUses,
        Instant expiresAt,
        Instant createdAt,
        UUID createdBy) {
}
