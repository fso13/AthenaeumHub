package ru.krug.backend.plugin.api.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * One AUDIO attachment of the music-room channel. Metadata only: no object key, hash,
 * presigned URL or content is exposed.
 */
public record MusicRoomTrackResponse(
        UUID id,
        UUID messageId,
        String filename,
        String mimeType,
        Long durationMs,
        String artworkUrl,
        String title,
        String artist,
        long sizeBytes,
        Instant createdAt) {
}
