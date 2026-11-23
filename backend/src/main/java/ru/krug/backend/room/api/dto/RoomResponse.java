package ru.krug.backend.room.api.dto;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** A room with the currently present participants (#105). */
public record RoomResponse(
        UUID id,
        UUID workspaceId,
        UUID chatId,
        String name,
        UUID createdBy,
        Instant createdAt,
        Instant updatedAt,
        String status,
        List<RoomParticipantResponse> participants,
        int participantCount,
        boolean myPresent) {
}
