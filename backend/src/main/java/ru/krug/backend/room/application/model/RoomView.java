package ru.krug.backend.room.application.model;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import ru.krug.backend.room.domain.model.Room;
import ru.krug.backend.room.domain.model.RoomParticipant;

/**
 * Room with the currently present participants (30 s TTL). {@code chatId} is the managed
 * GROUP channel used by the existing call signalling; {@code mediaMode} is the #107
 * AUDIO|VIDEO preference consumed by that frontend call code.
 */
public record RoomView(
        UUID id,
        UUID workspaceId,
        UUID chatId,
        String name,
        String mediaMode,
        UUID createdBy,
        Instant createdAt,
        Instant updatedAt,
        String status,
        List<RoomParticipantView> participants,
        int participantCount,
        boolean myPresent) {

    public static RoomView from(Room room, List<RoomParticipant> participants,
                                UUID viewerId) {
        List<RoomParticipantView> views = participants.stream()
                .map(RoomParticipantView::from)
                .toList();
        boolean mine = participants.stream()
                .anyMatch(participant -> participant.userId().equals(viewerId));
        return new RoomView(room.id(), room.workspaceId(), room.chatId(), room.name(),
                room.mediaMode().name(), room.createdBy(), room.createdAt(), room.updatedAt(),
                room.status().name(), views, views.size(), mine);
    }
}
