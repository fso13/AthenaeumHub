package ru.krug.backend.plugin.application.model;

import java.util.List;
import java.util.UUID;

/** {@code GET /chats/{chatId}/music-room} read model. */
public record MusicRoomTracksView(
        UUID chatId,
        MusicRoomPluginStateView plugin,
        List<MusicRoomTrackView> items,
        boolean hasMore) {

    public MusicRoomTracksView {
        items = items == null ? List.of() : List.copyOf(items);
    }
}
