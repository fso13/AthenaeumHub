package ru.krug.backend.plugin.application.model;

import java.time.Instant;
import java.util.UUID;

/**
 * Chat projection returned by {@code POST /workspaces/{id}/music-room} (#94). Mirrors the
 * contract {@code Chat} without importing the chat API/DTO layer.
 */
public record MusicRoomChatView(
        UUID id,
        String type,
        String securityMode,
        String visibility,
        UUID peerId,
        boolean peerHasE2eeCapableDevices,
        String name,
        String description,
        Integer keyEpoch,
        long lastSeq,
        long unreadCount,
        Instant createdAt,
        UUID coverFileId,
        UUID avatarFileId,
        boolean readOnly,
        String joinPolicy,
        boolean archived) {
}
