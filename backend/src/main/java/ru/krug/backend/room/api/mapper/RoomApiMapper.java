package ru.krug.backend.room.api.mapper;

import java.util.List;

import ru.krug.backend.room.api.dto.RoomListResponse;
import ru.krug.backend.room.api.dto.RoomParticipantResponse;
import ru.krug.backend.room.api.dto.RoomResponse;
import ru.krug.backend.room.application.model.RoomListView;
import ru.krug.backend.room.application.model.RoomParticipantView;
import ru.krug.backend.room.application.model.RoomView;

/** Room application read models -> API DTOs. No domain or persistence imports. */
public final class RoomApiMapper {

    private RoomApiMapper() {
    }

    public static RoomListResponse toResponse(RoomListView view) {
        return new RoomListResponse(view.items().stream()
                .map(RoomApiMapper::toResponse)
                .toList());
    }

    public static RoomResponse toResponse(RoomView view) {
        List<RoomParticipantResponse> participants = view.participants().stream()
                .map(RoomApiMapper::toResponse)
                .toList();
        return new RoomResponse(view.id(), view.workspaceId(), view.chatId(), view.name(),
                view.mediaMode(), view.createdBy(), view.createdAt(), view.updatedAt(),
                view.status(), participants, view.participantCount(), view.myPresent());
    }

    public static RoomParticipantResponse toResponse(RoomParticipantView view) {
        return new RoomParticipantResponse(view.userId(), view.displayName(), view.joinedAt(),
                view.lastSeenAt());
    }
}
