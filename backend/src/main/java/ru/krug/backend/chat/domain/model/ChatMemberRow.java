package ru.krug.backend.chat.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * One ACTIVE chat member with the display fields exposed by
 * {@code GET /chats/{chatId}/members} (#79). Produced by the narrow
 * {@code chat.member_directory} SECURITY DEFINER lookup, never by a cross-RLS join in the
 * application layer. Carries no email, device or key data.
 */
public record ChatMemberRow(
        UUID userId,
        String displayName,
        String role,
        String status,
        Instant joinedAt) {

    public ChatMemberRow {
        Objects.requireNonNull(userId, "userId");
        Objects.requireNonNull(role, "role");
        Objects.requireNonNull(status, "status");
    }
}
