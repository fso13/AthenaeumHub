package ru.krug.backend.chat.application.model;

import java.time.Instant;
import java.util.UUID;

/** One invite link as exposed by the API (#79); never contains the token or its hash. */
public record ChatInviteView(
        UUID id,
        String role,
        String status,
        int usedCount,
        Integer maxUses,
        Instant expiresAt,
        Instant createdAt,
        UUID createdBy) {
}
