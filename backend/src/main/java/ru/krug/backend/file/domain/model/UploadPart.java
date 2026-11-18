package ru.krug.backend.file.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/** One received multipart chunk. Identity is (uploadId, partNo), matching S3 multipart. */
public record UploadPart(
        UUID uploadId,
        UUID workspaceId,
        int partNo,
        Sha256 sha256,
        long sizeBytes,
        String etag,
        Instant createdAt) {

    public UploadPart {
        Objects.requireNonNull(uploadId, "uploadId");
        Objects.requireNonNull(workspaceId, "workspaceId");
        Objects.requireNonNull(sha256, "sha256");
        Objects.requireNonNull(createdAt, "createdAt");
        if (partNo < 1 || partNo > 10_000) {
            throw new IllegalArgumentException("part_no outside 1..10000");
        }
        if (sizeBytes <= 0) {
            throw new IllegalArgumentException("part size must be > 0");
        }
    }

    public static UploadPart received(UUID uploadId, UUID workspaceId, int partNo,
                                      Sha256 sha256, long sizeBytes, String etag, Instant now) {
        return new UploadPart(uploadId, workspaceId, partNo, sha256, sizeBytes, etag, now);
    }

    public boolean sameHash(Sha256 other) {
        return sha256.matches(other);
    }
}
