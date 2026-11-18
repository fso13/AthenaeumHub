package ru.krug.backend.chat.api.dto;

import java.time.Instant;
import java.util.UUID;

public record ChatSummaryResponse(
        UUID id,
        String name,
        String type,
        String securityMode,
        UUID peerId,
        boolean peerHasE2eeCapableDevices,
        Instant lastMessageAt,
        long unreadCount,
        long lastSeq) {
}
