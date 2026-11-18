package ru.krug.backend.message.api.dto;

import java.util.UUID;

public record AttachmentRefResponse(
        UUID id,
        String filename,
        long sizeBytes,
        String mimeType,
        String scanStatus,
        AttachmentMediaResponse media) {
}
