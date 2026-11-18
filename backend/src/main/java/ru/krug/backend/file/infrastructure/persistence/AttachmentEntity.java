package ru.krug.backend.file.infrastructure.persistence;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import ru.krug.backend.file.domain.model.Attachment;
import ru.krug.backend.file.domain.model.AttachmentStatus;
import ru.krug.backend.file.domain.model.MediaMetadata;
import ru.krug.backend.file.domain.model.ScanStatus;
import ru.krug.backend.file.domain.model.Sha256;

@Entity
@Table(name = "attachments", schema = "file")
public class AttachmentEntity {

    @Id
    private UUID id;

    @Column(name = "workspace_id", nullable = false)
    private UUID workspaceId;

    @Column(name = "chat_id", nullable = false)
    private UUID chatId;

    @Column(name = "upload_id", nullable = false)
    private UUID uploadId;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(name = "message_id")
    private UUID messageId;

    @Column(name = "filename", nullable = false)
    private String filename;

    @Column(name = "mime_type")
    private String mimeType;

    /** D1-BE2: sanitized client media metadata; null for plain/legacy files. */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "media", columnDefinition = "jsonb")
    private Map<String, Object> media;

    @Column(name = "size_bytes", nullable = false)
    private Long sizeBytes;

    @Column(name = "sha256", nullable = false)
    private String sha256;

    @Column(name = "object_key", nullable = false)
    private String objectKey;

    @Column(name = "status", nullable = false)
    private String status;

    @Column(name = "scan_status", nullable = false)
    private String scanStatus;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Column(name = "deleted_at")
    private Instant deletedAt;

    protected AttachmentEntity() {
    }

    public static AttachmentEntity from(Attachment attachment) {
        AttachmentEntity entity = new AttachmentEntity();
        entity.id = attachment.id();
        entity.workspaceId = attachment.workspaceId();
        entity.chatId = attachment.chatId();
        entity.uploadId = attachment.uploadId();
        entity.userId = attachment.userId();
        entity.messageId = attachment.messageId();
        entity.filename = attachment.filename();
        entity.mimeType = attachment.mimeType();
        entity.media = attachment.media() == null ? null : attachment.media().toMap();
        entity.sizeBytes = attachment.sizeBytes();
        entity.sha256 = attachment.sha256().value();
        entity.objectKey = attachment.objectKey();
        entity.status = attachment.status().name();
        entity.scanStatus = attachment.scanStatus().name();
        entity.createdAt = attachment.createdAt();
        entity.updatedAt = attachment.updatedAt();
        entity.deletedAt = attachment.deletedAt();
        return entity;
    }

    public Attachment toDomain() {
        return Attachment.reconstitute(id, workspaceId, chatId, uploadId, userId, messageId,
                filename, mimeType, MediaMetadata.fromMap(media), sizeBytes,
                Sha256.of(sha256), objectKey, AttachmentStatus.valueOf(status),
                ScanStatus.valueOf(scanStatus), createdAt, updatedAt, deletedAt);
    }

    public UUID getId() {
        return id;
    }

    public UUID getWorkspaceId() {
        return workspaceId;
    }

    public UUID getChatId() {
        return chatId;
    }

    public UUID getUploadId() {
        return uploadId;
    }

    public UUID getUserId() {
        return userId;
    }

    public UUID getMessageId() {
        return messageId;
    }

    public String getFilename() {
        return filename;
    }

    public String getMimeType() {
        return mimeType;
    }

    public Map<String, Object> getMedia() {
        return media;
    }

    public Long getSizeBytes() {
        return sizeBytes;
    }

    public String getSha256() {
        return sha256;
    }

    public String getObjectKey() {
        return objectKey;
    }

    public String getStatus() {
        return status;
    }

    public String getScanStatus() {
        return scanStatus;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}
