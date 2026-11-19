package ru.krug.backend.file.api.dto;

/**
 * OpenAPI {@code AttachmentRef.media}: sanitized managed-only metadata. Imported by the
 * file-center response; never populated for E2EE attachments (they are not listed).
 */
public record FileMediaResponse(
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
