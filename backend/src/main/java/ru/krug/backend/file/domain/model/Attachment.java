package ru.krug.backend.file.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

import ru.krug.backend.file.domain.exception.AttachmentNotReadyException;
import ru.krug.backend.file.domain.exception.AttachmentQuarantinedException;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Managed attachment aggregate. AV is fail-closed: only READY/BOUND + CLEAN (or SKIPPED) is
 * downloadable; INFECTED/FAILED are quarantined and return 423.
 */
public final class Attachment {

    private final UUID id;
    private final UUID workspaceId;
    private final UUID chatId;
    private final UUID uploadId;
    private final UUID userId;
    private final UUID messageId;
    private final String filename;
    private final String mimeType;
    private final long sizeBytes;
    private final Sha256 sha256;
    private final String objectKey;
    private final AttachmentStatus status;
    private final ScanStatus scanStatus;
    private final Instant createdAt;
    private final Instant updatedAt;
    private final Instant deletedAt;

    private Attachment(UUID id, UUID workspaceId, UUID chatId, UUID uploadId, UUID userId,
                       UUID messageId, String filename, String mimeType, long sizeBytes,
                       Sha256 sha256, String objectKey, AttachmentStatus status,
                       ScanStatus scanStatus, Instant createdAt, Instant updatedAt,
                       Instant deletedAt) {
        this.id = Objects.requireNonNull(id, "id");
        this.workspaceId = Objects.requireNonNull(workspaceId, "workspaceId");
        this.chatId = Objects.requireNonNull(chatId, "chatId");
        this.uploadId = Objects.requireNonNull(uploadId, "uploadId");
        this.userId = Objects.requireNonNull(userId, "userId");
        this.messageId = messageId;
        this.filename = Objects.requireNonNull(filename, "filename");
        this.mimeType = mimeType;
        this.sizeBytes = sizeBytes;
        this.sha256 = Objects.requireNonNull(sha256, "sha256");
        this.objectKey = Objects.requireNonNull(objectKey, "objectKey");
        this.status = Objects.requireNonNull(status, "status");
        this.scanStatus = Objects.requireNonNull(scanStatus, "scanStatus");
        this.createdAt = Objects.requireNonNull(createdAt, "createdAt");
        this.updatedAt = Objects.requireNonNull(updatedAt, "updatedAt");
        this.deletedAt = deletedAt;
        if (sizeBytes <= 0) {
            throw new IllegalArgumentException("attachment size must be > 0");
        }
    }

    public static Attachment uploaded(UUID id, UUID workspaceId, UUID chatId, UUID uploadId,
                                      UUID userId, String filename, String mimeType,
                                      long sizeBytes, Sha256 sha256, String objectKey,
                                      Instant now) {
        return new Attachment(id, workspaceId, chatId, uploadId, userId, null, filename, mimeType,
                sizeBytes, sha256, objectKey, AttachmentStatus.READY, ScanStatus.PENDING, now,
                now, null);
    }

    public static Attachment reconstitute(UUID id, UUID workspaceId, UUID chatId, UUID uploadId,
                                          UUID userId, UUID messageId, String filename,
                                          String mimeType, long sizeBytes, Sha256 sha256,
                                          String objectKey, AttachmentStatus status,
                                          ScanStatus scanStatus, Instant createdAt,
                                          Instant updatedAt, Instant deletedAt) {
        return new Attachment(id, workspaceId, chatId, uploadId, userId, messageId, filename,
                mimeType, sizeBytes, sha256, objectKey, status, scanStatus, createdAt, updatedAt,
                deletedAt);
    }

    public Attachment markClean(Instant now) {
        return with(AttachmentStatus.READY, ScanStatus.CLEAN, now, messageId);
    }

    public Attachment markInfected(Instant now) {
        return with(AttachmentStatus.QUARANTINED, ScanStatus.INFECTED, now, messageId);
    }

    public Attachment markScanFailed(Instant now) {
        return with(AttachmentStatus.QUARANTINED, ScanStatus.FAILED, now, messageId);
    }

    public Attachment markSkipped(Instant now) {
        return with(AttachmentStatus.READY, ScanStatus.SKIPPED, now, messageId);
    }

    public Attachment bindTo(UUID messageIdValue, Instant now) {
        assertBindable();
        return with(AttachmentStatus.BOUND, scanStatus, now, messageIdValue);
    }

    public Attachment markDeleted(Instant now) {
        return new Attachment(id, workspaceId, chatId, uploadId, userId, messageId, filename,
                mimeType, sizeBytes, sha256, objectKey, AttachmentStatus.DELETED, scanStatus,
                createdAt, now, now);
    }

    /**
     * @throws AttachmentQuarantinedException 423 for INFECTED/FAILED
     * @throws AttachmentNotReadyException 409 while scanning or for non-downloadable states
     */
    public void assertDownloadable() {
        if (status == AttachmentStatus.QUARANTINED || scanStatus.quarantined()) {
            throw new AttachmentQuarantinedException(scanStatus.name());
        }
        if (status == AttachmentStatus.DELETED) {
            throw new DomainException(ErrorCategory.GONE, ErrorCode.ATTACHMENT_DELETED,
                    "Attachment is deleted", java.util.Map.of(), null);
        }
        if (!status.downloadable() || !scanStatus.downloadable()) {
            throw new AttachmentNotReadyException(status.name(), scanStatus.name());
        }
    }

    public void assertBindable() {
        if (status == AttachmentStatus.QUARANTINED || scanStatus.quarantined()) {
            throw new AttachmentQuarantinedException(scanStatus.name());
        }
        if (status != AttachmentStatus.READY || !scanStatus.downloadable()) {
            throw new AttachmentNotReadyException(status.name(), scanStatus.name());
        }
    }

    public boolean isOwnedBy(UUID user) {
        return userId.equals(user);
    }

    public boolean belongsToChat(UUID chat) {
        return chatId.equals(chat);
    }

    public boolean isBound() {
        return status == AttachmentStatus.BOUND;
    }

    public boolean isDownloadable() {
        return status.downloadable() && scanStatus.downloadable();
    }

    private Attachment with(AttachmentStatus nextStatus, ScanStatus nextScan, Instant now,
                            UUID nextMessageId) {
        return new Attachment(id, workspaceId, chatId, uploadId, userId, nextMessageId, filename,
                mimeType, sizeBytes, sha256, objectKey, nextStatus, nextScan, createdAt, now,
                deletedAt);
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

    public UUID uploadId() {
        return uploadId;
    }

    public UUID userId() {
        return userId;
    }

    public UUID messageId() {
        return messageId;
    }

    public String filename() {
        return filename;
    }

    public String mimeType() {
        return mimeType;
    }

    public long sizeBytes() {
        return sizeBytes;
    }

    public Sha256 sha256() {
        return sha256;
    }

    public String objectKey() {
        return objectKey;
    }

    public AttachmentStatus status() {
        return status;
    }

    public ScanStatus scanStatus() {
        return scanStatus;
    }

    public Instant createdAt() {
        return createdAt;
    }

    public Instant updatedAt() {
        return updatedAt;
    }

    public Instant deletedAt() {
        return deletedAt;
    }
}
