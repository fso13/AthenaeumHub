package ru.krug.backend.file.infrastructure.persistence;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.Table;

import ru.krug.backend.file.domain.model.Sha256;
import ru.krug.backend.file.domain.model.UploadPart;

@Entity
@Table(name = "upload_parts", schema = "file")
public class UploadPartEntity {

    @EmbeddedId
    private UploadPartId id;

    @Column(name = "workspace_id", nullable = false)
    private UUID workspaceId;

    @Column(name = "sha256", nullable = false)
    private String sha256;

    @Column(name = "size_bytes", nullable = false)
    private Long sizeBytes;

    @Column(name = "etag")
    private String etag;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected UploadPartEntity() {
    }

    public static UploadPartEntity from(UploadPart part) {
        UploadPartEntity entity = new UploadPartEntity();
        entity.id = new UploadPartId(part.uploadId(), part.partNo());
        entity.workspaceId = part.workspaceId();
        entity.sha256 = part.sha256().value();
        entity.sizeBytes = part.sizeBytes();
        entity.etag = part.etag();
        entity.createdAt = part.createdAt();
        return entity;
    }

    public UploadPart toDomain() {
        return new UploadPart(id.getUploadId(), workspaceId, id.getPartNo(),
                Sha256.of(sha256), sizeBytes, etag, createdAt);
    }

    public UploadPartId getId() {
        return id;
    }

    public UUID getWorkspaceId() {
        return workspaceId;
    }

    public String getSha256() {
        return sha256;
    }

    public Long getSizeBytes() {
        return sizeBytes;
    }

    public String getEtag() {
        return etag;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}
