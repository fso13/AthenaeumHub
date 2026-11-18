package ru.krug.backend.realtime.application.model;

/**
 * Media metadata projection for WS payloads (OpenAPI {@code AttachmentRef.media}). Managed
 * only: E2EE messages carry no attachments and therefore no media snapshot.
 */
public record AttachmentMediaSnapshot(
        String kind,
        Long durationMs,
        Integer width,
        Integer height,
        String title,
        String artist,
        String album,
        String year,
        String genre,
        String artworkUrl,
        String metadataSource) {
}
