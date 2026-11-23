package ru.krug.backend.room.application.model;

import java.time.Instant;
import java.util.UUID;

import ru.krug.backend.room.domain.model.RoomParticipant;

/** One live participant of a room (#105). */
public record RoomParticipantView(
        UUID userId,
        String displayName,
        Instant joinedAt,
        Instant lastSeenAt) {

    public static RoomParticipantView from(RoomParticipant participant) {
        return new RoomParticipantView(participant.userId(), participant.displayName(),
                participant.joinedAt(), participant.lastSeenAt());
    }
}
