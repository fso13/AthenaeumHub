package ru.krug.backend.file.application.model;

import java.time.Instant;
import java.util.UUID;

import ru.krug.backend.file.domain.model.MediaMetadata;

/**
 * Application read model for one row returned by the file-center query. Carries only
 * attachment metadata plus chat/message provenance; no object key, hash, bytes or URL.
 */
public record FileCenterRow(
        UUID id,
        UUID chatId,
        String chatName,
        UUID messageId,
        String filename,
        String mimeType,
        MediaMetadata media,
        long sizeBytes,
        String scanStatus,
        Instant createdAt) {
}
