package ru.krug.backend.message.api.dto;

/**
 * OpenAPI {@code AttachmentRef.media}. Managed-only, sanitized metadata; {@code null} for
 * plain/legacy attachments and never present for E2EE messages.
 */
public record AttachmentMediaResponse(
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
