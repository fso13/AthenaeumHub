package ru.krug.backend.plugin.application.model;

import java.time.Instant;
import java.util.UUID;

/**
 * One AUDIO attachment of the music-room channel. Metadata only: no object key, content
 * hash, presigned URL or bytes can be obtained from this view.
 */
public record MusicRoomTrackView(
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
