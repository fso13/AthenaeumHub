package ru.krug.backend.file.application.model;

/**
 * Sanitized managed media metadata exposed by the file center (OpenAPI
 * {@code AttachmentRef.media}). {@code null} for plain/legacy attachments and never present
 * for E2EE attachments.
 */
public record FileMediaView(
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
