package ru.krug.backend.plugin.api.dto;

import java.time.Instant;
import java.util.UUID;

/** Contract {@code Chat} projection returned by the music-room open endpoint (#94). */
public record MusicRoomChatResponse(
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
