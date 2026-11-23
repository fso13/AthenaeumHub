package ru.krug.backend.chat.application.model;

import java.time.Instant;
import java.util.UUID;

public record ChatSummaryView(
        UUID id,
        String name,
        String description,
        String type,
        String securityMode,
        String visibility,
        Instant lastMessageAt,
        long unreadCount,
        long lastSeq,
        UUID peerId,
        boolean peerHasE2eeCapableDevices,
        java.time.Instant createdAt,
        UUID coverFileId,
        UUID avatarFileId,
        boolean readOnly,
        String joinPolicy,
        boolean archived,
        int memberCount) {
}
