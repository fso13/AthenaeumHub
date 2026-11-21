package ru.krug.backend.plugin.application.model;

/**
 * Result of the idempotent music-room open: the channel plus its plugin state.
 *
 * @param created {@code true} only when this request created a new channel (HTTP 201);
 *                a replay/reuse of the existing room is {@code false} (HTTP 200)
 */
public record MusicRoomOpenView(MusicRoomChatView chat, MusicRoomPluginStateView plugin,
                                boolean created) {
}
