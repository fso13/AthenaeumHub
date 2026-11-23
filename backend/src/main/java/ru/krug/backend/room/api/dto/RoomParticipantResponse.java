package ru.krug.backend.room.api.dto;

import java.time.Instant;
import java.util.UUID;

/** One participant whose heartbeat is inside the 30-second TTL. */
public record RoomParticipantResponse(
        UUID userId,
        String displayName,
        Instant joinedAt,
        Instant lastSeenAt) {
}
