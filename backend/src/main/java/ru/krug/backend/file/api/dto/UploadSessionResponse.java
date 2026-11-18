package ru.krug.backend.file.api.dto;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

public record UploadSessionResponse(
        UUID uploadId,
        String status,
        int partSize,
        int totalParts,
        List<Integer> receivedParts,
        Instant expiresAt,
        UUID attachmentId) {
}
