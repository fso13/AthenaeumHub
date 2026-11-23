package ru.krug.backend.room.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/** One participant currently present in a room, as returned by the TTL directory query. */
public record RoomParticipant(
        UUID roomId,
        UUID userId,
        String displayName,
        Instant joinedAt,
        Instant lastSeenAt) {

    public RoomParticipant {
        Objects.requireNonNull(roomId, "roomId");
        Objects.requireNonNull(userId, "userId");
        Objects.requireNonNull(displayName, "displayName");
        Objects.requireNonNull(joinedAt, "joinedAt");
        Objects.requireNonNull(lastSeenAt, "lastSeenAt");
    }
}
