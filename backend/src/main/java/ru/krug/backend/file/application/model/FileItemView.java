package ru.krug.backend.file.application.model;

import java.time.Instant;
import java.util.UUID;

/** One file-center item: {@code AttachmentRef} metadata plus chat/message provenance. */
public record FileItemView(
        UUID id,
        String filename,
        long sizeBytes,
        String mimeType,
        String scanStatus,
        FileMediaView media,
        UUID chatId,
        String chatName,
        UUID messageId,
        Instant createdAt) {
}
