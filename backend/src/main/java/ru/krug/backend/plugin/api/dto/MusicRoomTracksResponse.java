package ru.krug.backend.plugin.api.dto;

import java.util.List;
import java.util.UUID;

/** {@code GET /chats/{chatId}/music-room} response. */
public record MusicRoomTracksResponse(
        UUID chatId,
        MusicRoomPluginResponse plugin,
        List<MusicRoomTrackResponse> items,
        boolean hasMore) {
}
