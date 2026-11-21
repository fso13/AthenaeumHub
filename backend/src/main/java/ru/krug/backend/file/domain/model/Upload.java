package ru.krug.backend.file.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

import ru.krug.backend.file.domain.exception.UploadExpiredException;
import ru.krug.backend.file.domain.exception.UploadStateException;

/**
 * Managed upload aggregate root. Parts are a separate aggregate (upload_parts) because they
 * have their own lifecycle and are never loaded for session reads; the aggregate keeps the
 * invariants that depend on the whole session (size/parts/status/TTL).
 */
public final class Upload {

    private final UUID id;
    private final UUID workspaceId;
    private final UUID chatId;
    private final UUID userId;
    private final String filename;
    private final String mimeType;
    private final MediaMetadata media;
    private final long sizeBytes;
    private final Sha256 sha256;
    private final String encryptionMode;
    private final int partSize;
    private final int totalParts;
    private final String objectKey;
    private final String storageUploadId;
    private final UUID attachmentId;
    private final UploadStatus status;
    private final Instant expiresAt;
    private final Instant createdAt;
    private final Instant updatedAt;
    private final Instant completedAt;

    private Upload(UUID id, UUID workspaceId, UUID chatId, UUID userId, String filename,
                   String mimeType, MediaMetadata media, long sizeBytes, Sha256 sha256,
                   String encryptionMode,
                   int partSize, int totalParts, String objectKey, String storageUploadId,
                   UUID attachmentId, UploadStatus status, Instant expiresAt, Instant createdAt,
                   Instant updatedAt, Instant completedAt) {
        this.id = Objects.requireNonNull(id, "id");
        this.workspaceId = Objects.requireNonNull(workspaceId, "workspaceId");
        // chatId is null only for a workspace-scoped global file (#83): the upload session,
        // quota reservation and AV scan are identical, but the file has no chat yet.
        this.chatId = chatId;
        this.userId = Objects.requireNonNull(userId, "userId");
        this.filename = requireFilename(filename);
        this.mimeType = mimeType;
        this.media = media;
        this.sizeBytes = sizeBytes;
        this.sha256 = sha256;
        this.encryptionMode = encryptionMode;
        this.partSize = partSize;
        this.totalParts = totalParts;
        this.objectKey = Objects.requireNonNull(objectKey, "objectKey");
        this.storageUploadId = storageUploadId;
        this.attachmentId = attachmentId;
        this.status = Objects.requireNonNull(status, "status");
        this.expiresAt = Objects.requireNonNull(expiresAt, "expiresAt");
        this.createdAt = Objects.requireNonNull(createdAt, "createdAt");
        this.updatedAt = Objects.requireNonNull(updatedAt, "updatedAt");
        this.completedAt = completedAt;
        if (sizeBytes <= 0) {
            throw new IllegalArgumentException("size must be > 0");
        }
        if (partSize <= 0 || totalParts <= 0 || totalParts > FileSize.MAX_PARTS) {
            throw new IllegalArgumentException("invalid part sizing");
        }
    }

    public static Upload create(UUID id, UUID workspaceId, UUID chatId, UUID userId,
                                String filename, String mimeType, long sizeBytes, Sha256 sha256,
                                Instant now, Instant expiresAt) {
        return create(id, workspaceId, chatId, userId, filename, mimeType, null, sizeBytes, sha256,
                now, expiresAt);
    }

    /** Global workspace file (#83): a regular upload session with no chat binding. */
    public static Upload createWorkspaceFile(UUID id, UUID workspaceId, UUID userId,
                                             String filename, String mimeType,
                                             MediaMetadata media, long sizeBytes,
                                             Instant now, Instant expiresAt) {
        return create(id, workspaceId, null, userId, filename, mimeType, media, sizeBytes, null,
                now, expiresAt);
    }

    public static Upload create(UUID id, UUID workspaceId, UUID chatId, UUID userId,
                                String filename, String mimeType, MediaMetadata media,
                                long sizeBytes, Sha256 sha256, Instant now, Instant expiresAt) {
        FileSize size = FileSize.of(sizeBytes);
        int partSize = FileSize.DEFAULT_PART_SIZE;
        int totalParts = size.totalParts(partSize);
        String objectKey = "workspaces/" + workspaceId + "/files/" + id;
        return new Upload(id, workspaceId, chatId, userId, filename, mimeType, media, sizeBytes,
                sha256, "MANAGED", partSize, totalParts, objectKey, null, null,
                UploadStatus.INIT, expiresAt, now, now, null);
    }

    public static Upload reconstitute(UUID id, UUID workspaceId, UUID chatId, UUID userId,
                                      String filename, String mimeType, MediaMetadata media,
                                      long sizeBytes, Sha256 sha256, String encryptionMode,
                                      int partSize, int totalParts, String objectKey,
                                      String storageUploadId, UUID attachmentId,
                                      UploadStatus status, Instant expiresAt, Instant createdAt,
                                      Instant updatedAt, Instant completedAt) {
        return new Upload(id, workspaceId, chatId, userId, filename, mimeType, media, sizeBytes,
                sha256, encryptionMode, partSize, totalParts, objectKey, storageUploadId,
                attachmentId, status, expiresAt, createdAt, updatedAt, completedAt);
    }

    public Upload withStorageUploadId(String storageUploadId, Instant now) {
        return new Upload(id, workspaceId, chatId, userId, filename, mimeType, media, sizeBytes,
                sha256, encryptionMode, partSize, totalParts, objectKey, storageUploadId,
                attachmentId, status, expiresAt, createdAt, now, completedAt);
    }

    public Upload markUploading(Instant now) {
        if (status == UploadStatus.UPLOADING) {
            return this;
        }
        if (!status.acceptsParts()) {
            throw new UploadStateException(status.name(), "upload_part");
        }
        return withStatus(UploadStatus.UPLOADING, now, completedAt);
    }

    public Upload markCompleting(Instant now) {
        if (!status.acceptsParts() && status != UploadStatus.COMPLETING) {
            throw new UploadStateException(status.name(), "complete");
        }
        return withStatus(UploadStatus.COMPLETING, now, completedAt);
    }

    public Upload markScanning(UUID attachmentIdValue, Instant now) {
        return new Upload(id, workspaceId, chatId, userId, filename, mimeType, media, sizeBytes,
                sha256, encryptionMode, partSize, totalParts, objectKey, storageUploadId,
                attachmentIdValue, UploadStatus.SCANNING, expiresAt, createdAt, now, now);
    }

    public Upload markReady(Instant now) {
        return withStatus(UploadStatus.READY, now, completedAt == null ? now : completedAt);
    }

    public Upload markBound(Instant now) {
        return withStatus(UploadStatus.BOUND, now, completedAt == null ? now : completedAt);
    }

    public Upload markFailed(Instant now) {
        return withStatus(UploadStatus.FAILED, now, completedAt);
    }

    /** AV INFECTED or scanner failure: fail-closed terminal state, download is 423. */
    public Upload markQuarantined(Instant now) {
        return withStatus(UploadStatus.QUARANTINED, now, completedAt == null ? now : completedAt);
    }

    public Upload abort(Instant now) {
        if (status == UploadStatus.ABORTED) {
            return this;
        }
        if (!status.canAbort()) {
            throw new UploadStateException(status.name(), "abort");
        }
        return withStatus(UploadStatus.ABORTED, now, completedAt);
    }

    public Upload expire(Instant now) {
        // READY is terminal for uploads, but an unbound READY object is exactly what the GC
        // expires after the 24h TTL; only already-closed/quarantined states are immutable.
        if (status == UploadStatus.EXPIRED || status == UploadStatus.ABORTED
                || status == UploadStatus.BOUND || status == UploadStatus.QUARANTINED
                || status == UploadStatus.FAILED) {
            return this;
        }
        return withStatus(UploadStatus.EXPIRED, now, completedAt);
    }

    public boolean isExpired(Instant now) {
        return !status.terminal() && !now.isBefore(expiresAt);
    }

    public void assertAcceptingParts(Instant now) {
        if (status == UploadStatus.EXPIRED || isExpired(now)) {
            throw new UploadExpiredException(expiresAt);
        }
        if (!status.acceptsParts()) {
            throw new UploadStateException(status.name(), "upload_part");
        }
    }

    public long expectedPartLength(int partNo) {
        return FileSize.of(sizeBytes).partLength(partNo, partSize, totalParts);
    }

    public boolean matchesDeclaredSha(Sha256 declared) {
        return sha256 == null || sha256.matches(declared);
    }

    /**
     * #97: complete may replace empty client media with server-extracted metadata. The
     * resumable session keeps the same sanitized copy for later GET upload reads.
     */
    public Upload withMedia(MediaMetadata value, Instant now) {
        return new Upload(id, workspaceId, chatId, userId, filename, mimeType, value, sizeBytes,
                sha256, encryptionMode, partSize, totalParts, objectKey, storageUploadId,
                attachmentId, status, expiresAt, createdAt, now, completedAt);
    }

    public Upload withSha(Sha256 value, Instant now) {
        return new Upload(id, workspaceId, chatId, userId, filename, mimeType, media, sizeBytes,
                value, encryptionMode, partSize, totalParts, objectKey, storageUploadId,
                attachmentId, status, expiresAt, createdAt, now, completedAt);
    }

    private Upload withStatus(UploadStatus next, Instant now, Instant completed) {
        return new Upload(id, workspaceId, chatId, userId, filename, mimeType, media, sizeBytes,
                sha256, encryptionMode, partSize, totalParts, objectKey, storageUploadId,
                attachmentId, next, expiresAt, createdAt, now, completed);
    }

    private static String requireFilename(String filename) {
        if (filename == null || filename.isBlank() || filename.length() > 255) {
            throw new IllegalArgumentException("filename must be 1..255 characters");
        }
        return filename;
    }

    public UUID id() {
        return id;
    }

    public UUID workspaceId() {
        return workspaceId;
    }

    public UUID chatId() {
        return chatId;
    }

    public UUID userId() {
        return userId;
    }

    public String filename() {
        return filename;
    }

    public String mimeType() {
        return mimeType;
    }

    public MediaMetadata media() {
        return media;
    }

    public long sizeBytes() {
        return sizeBytes;
    }

    public Sha256 sha256() {
        return sha256;
    }

    public String encryptionMode() {
        return encryptionMode;
    }

    public int partSize() {
        return partSize;
    }

    public int totalParts() {
        return totalParts;
    }

    public String objectKey() {
        return objectKey;
    }

    public String storageUploadId() {
        return storageUploadId;
    }

    public UUID attachmentId() {
        return attachmentId;
    }

    public UploadStatus status() {
        return status;
    }

    public Instant expiresAt() {
        return expiresAt;
    }

    public Instant createdAt() {
        return createdAt;
    }

    public Instant updatedAt() {
        return updatedAt;
    }

    public Instant completedAt() {
        return completedAt;
    }
}
