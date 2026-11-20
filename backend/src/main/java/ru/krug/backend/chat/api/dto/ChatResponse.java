package ru.krug.backend.chat.api.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * OpenAPI {@code Chat} (I-01/D-S4-01). {@code visibility}, {@code join_policy} and
 * {@code cover_file_id} are GROUP-only and nullable; {@code read_only} and {@code archived}
 * are additive P0-2 fields ({@code archived} is the caller's own archive state).
 */
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
        Instant createdAt,
        UUID coverFileId,
        boolean readOnly,
        String joinPolicy,
        boolean archived) {
}
