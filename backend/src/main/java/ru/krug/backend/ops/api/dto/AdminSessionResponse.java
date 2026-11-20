package ru.krug.backend.ops.api.dto;

import java.time.Instant;
import java.util.UUID;

/** Response DTO for one platform-admin session (contract {@code AdminSession}). */
public record AdminSessionResponse(
        String id,
        UUID userId,
        String device,
        Instant createdAt,
        Instant lastSeenAt,
        boolean current) {
}
