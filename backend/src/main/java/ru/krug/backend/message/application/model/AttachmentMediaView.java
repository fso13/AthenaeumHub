package ru.krug.backend.message.application.model;

/**
 * Media metadata projection owned by the message context. The file context maps its
 * sanitized {@code MediaMetadata} into this record, so message application never imports
 * file domain classes. Null for plain/legacy attachments and always absent for E2EE
 * (E2EE messages cannot carry attachments in this slice).
 */
public record AttachmentMediaView(
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
