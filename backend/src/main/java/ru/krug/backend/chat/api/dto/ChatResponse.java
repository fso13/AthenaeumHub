package ru.krug.backend.chat.api.dto;

import java.time.Instant;
import java.util.UUID;

/** OpenAPI {@code Chat} (I-01/D-S4-01). */
public record ChatResponse(
        UUID id,
        String type,
        String securityMode,
        UUID peerId,
        boolean peerHasE2eeCapableDevices,
        String name,
        String description,
        Integer keyEpoch,
        long lastSeq,
        long unreadCount,
        Instant createdAt) {
}
