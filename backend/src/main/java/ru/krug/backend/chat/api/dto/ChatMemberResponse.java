package ru.krug.backend.chat.api.dto;

import java.time.Instant;
import java.util.UUID;

/** OpenAPI {@code ChatMember} (#79). No email, device or key fields. */
public record ChatMemberResponse(
        UUID userId,
        String displayName,
        String role,
        String status,
        Instant joinedAt) {
}
