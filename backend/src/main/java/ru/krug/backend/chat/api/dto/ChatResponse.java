package ru.krug.backend.chat.api.dto;

import java.time.Instant;
import java.util.UUID;

/** OpenAPI {@code Chat} (I-01/D-S4-01). {@code visibility} is GROUP-only and nullable. */
public record ChatResponse(
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
        Instant createdAt) {
}
