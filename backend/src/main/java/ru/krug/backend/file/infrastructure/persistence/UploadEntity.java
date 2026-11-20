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

import ru.krug.backend.file.domain.model.MediaMetadata;
import ru.krug.backend.file.domain.model.Sha256;
import ru.krug.backend.file.domain.model.Upload;
import ru.krug.backend.file.domain.model.UploadStatus;

@Entity
@Table(name = "uploads", schema = "file")
public class UploadEntity {

    @Id
    private UUID id;

    @Column(name = "workspace_id", nullable = false)
    private UUID workspaceId;

    /** Null only for a workspace-scoped global file (#83). */
    @Column(name = "chat_id")
    private UUID chatId;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

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

    @Column(name = "sha256")
    private String sha256;

    @Column(name = "encryption_mode", nullable = false)
    private String encryptionMode;

    @Column(name = "status", nullable = false)
    private String status;

    @Column(name = "part_size", nullable = false)
    private Integer partSize;

    @Column(name = "total_parts", nullable = false)
    private Integer totalParts;

    @Column(name = "object_key", nullable = false)
    private String objectKey;

    @Column(name = "storage_upload_id")
    private String storageUploadId;

    @Column(name = "attachment_id")
    private UUID attachmentId;

    @Column(name = "expires_at", nullable = false)
    private Instant expiresAt;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Column(name = "completed_at")
    private Instant completedAt;

    protected UploadEntity() {
    }

    public static UploadEntity from(Upload upload) {
        UploadEntity entity = new UploadEntity();
        entity.id = upload.id();
        entity.workspaceId = upload.workspaceId();
        entity.chatId = upload.chatId();
        entity.userId = upload.userId();
        entity.filename = upload.filename();
        entity.mimeType = upload.mimeType();
        entity.media = upload.media() == null ? null : upload.media().toMap();
        entity.sizeBytes = upload.sizeBytes();
        entity.sha256 = upload.sha256() == null ? null : upload.sha256().value();
        entity.encryptionMode = upload.encryptionMode();
        entity.status = upload.status().name();
        entity.partSize = upload.partSize();
        entity.totalParts = upload.totalParts();
        entity.objectKey = upload.objectKey();
        entity.storageUploadId = upload.storageUploadId();
        entity.attachmentId = upload.attachmentId();
        entity.expiresAt = upload.expiresAt();
        entity.createdAt = upload.createdAt();
        entity.updatedAt = upload.updatedAt();
        entity.completedAt = upload.completedAt();
        return entity;
    }

    public Upload toDomain() {
        return Upload.reconstitute(id, workspaceId, chatId, userId, filename, mimeType,
                MediaMetadata.fromMap(media), sizeBytes,
                sha256 == null ? null : Sha256.of(sha256), encryptionMode, partSize, totalParts,
                objectKey, storageUploadId, attachmentId, UploadStatus.valueOf(status), expiresAt,
                createdAt, updatedAt, completedAt);
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

    public UUID getUserId() {
        return userId;
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

    public String getStatus() {
        return status;
    }

    public Integer getPartSize() {
        return partSize;
    }

    public Integer getTotalParts() {
        return totalParts;
    }

    public String getObjectKey() {
        return objectKey;
    }

    public String getStorageUploadId() {
        return storageUploadId;
    }

    public UUID getAttachmentId() {
        return attachmentId;
    }

    public Instant getExpiresAt() {
        return expiresAt;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }
}
