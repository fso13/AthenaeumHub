package ru.krug.backend.plugin.api.dto;

/** {@code POST /workspaces/{workspaceId}/music-room} response: chat + plugin state. */
public record MusicRoomOpenResponse(
        MusicRoomChatResponse chat,
        MusicRoomPluginResponse plugin,
        boolean created) {
}
