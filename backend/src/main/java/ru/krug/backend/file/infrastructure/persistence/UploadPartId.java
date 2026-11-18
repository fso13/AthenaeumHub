package ru.krug.backend.file.infrastructure.persistence;

import java.io.Serializable;
import java.util.Objects;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Embeddable;

@Embeddable
public class UploadPartId implements Serializable {

    @Column(name = "upload_id", nullable = false)
    private UUID uploadId;

    @Column(name = "part_no", nullable = false)
    private Integer partNo;

    protected UploadPartId() {
    }

    public UploadPartId(UUID uploadId, Integer partNo) {
        this.uploadId = uploadId;
        this.partNo = partNo;
    }

    public UUID getUploadId() {
        return uploadId;
    }

    public Integer getPartNo() {
        return partNo;
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) {
            return true;
        }
        if (!(other instanceof UploadPartId that)) {
            return false;
        }
        return Objects.equals(uploadId, that.uploadId) && Objects.equals(partNo, that.partNo);
    }

    @Override
    public int hashCode() {
        return Objects.hash(uploadId, partNo);
    }
}
