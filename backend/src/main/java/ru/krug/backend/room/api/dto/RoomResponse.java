package ru.krug.backend.room.api.dto;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** A room with its AUDIO|VIDEO media mode and the currently present participants (#105/#107). */
public record RoomResponse(
        UUID id,
        UUID workspaceId,
        UUID chatId,
        String name,
        String mediaMode,
        UUID createdBy,
        Instant createdAt,
        Instant updatedAt,
        String status,
        List<RoomParticipantResponse> participants,
        int participantCount,
        boolean myPresent) {
}
