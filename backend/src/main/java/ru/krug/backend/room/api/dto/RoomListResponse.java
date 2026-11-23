package ru.krug.backend.room.api.dto;

import java.util.List;

/** {@code GET /workspaces/{workspaceId}/rooms} response. */
public record RoomListResponse(List<RoomResponse> items) {
}
