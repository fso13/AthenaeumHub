package ru.krug.backend.file.application.model;

import java.util.List;
import java.util.UUID;

import ru.krug.backend.file.domain.model.Upload;

public record UploadView(
        UUID uploadId,
        String status,
        int partSize,
        int totalParts,
        List<Integer> receivedParts,
        java.time.Instant expiresAt,
        UUID attachmentId) {

    public static UploadView from(Upload upload, List<Integer> receivedParts) {
        return new UploadView(upload.id(), upload.status().name(), upload.partSize(),
                upload.totalParts(), receivedParts, upload.expiresAt(), upload.attachmentId());
    }
}
