package ru.krug.backend.file.api.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * OpenAPI {@code FileItem}: attachment metadata plus chat/message provenance. Deliberately
 * contains no object key, content, sha256 or presigned URL.
 */
public record FileItemResponse(
        UUID id,
        String filename,
        long sizeBytes,
        String mimeType,
        String scanStatus,
        FileMediaResponse media,
        UUID chatId,
        String chatName,
        UUID messageId,
        Instant createdAt) {
}
