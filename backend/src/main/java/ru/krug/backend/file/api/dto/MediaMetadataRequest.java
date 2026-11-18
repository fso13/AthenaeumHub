package ru.krug.backend.file.api.dto;

/**
 * OpenAPI {@code UploadInitRequest.media} / {@code AttachmentRef.media}. All fields are
 * optional except kind and metadata_source; the application validates bounds and sanitizes
 * strings before anything is stored.
 */
public record MediaMetadataRequest(
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
