package ru.krug.backend.room.application.model;

import java.util.List;

/** {@code GET /workspaces/{workspaceId}/rooms} response. */
public record RoomListView(List<RoomView> items) {
}
