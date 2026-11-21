package ru.krug.backend.file.application.model;

import ru.krug.backend.file.domain.model.MediaMetadata;

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

    /** Maps a sanitized domain value to the file-center/API view; null stays null. */
    public static FileMediaView from(MediaMetadata media) {
        if (media == null) {
            return null;
        }
        return new FileMediaView(media.kind().name(), media.durationMs(), media.width(),
                media.height(), media.title(), media.artist(), media.album(), media.year(),
                media.genre(), media.artworkUrl(), media.metadataSource().name());
    }
}
