package ru.krug.backend.file.infrastructure.persistence;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import ru.krug.backend.file.domain.model.QuotaReservation;
import ru.krug.backend.file.domain.model.ReservationStatus;

@Entity
@Table(name = "quota_reservations", schema = "file")
public class QuotaReservationEntity {

    @Id
    private UUID id;

    @Column(name = "workspace_id", nullable = false)
    private UUID workspaceId;

    @Column(name = "upload_id", nullable = false)
    private UUID uploadId;

    @Column(name = "size_bytes", nullable = false)
    private Long sizeBytes;

    @Column(name = "status", nullable = false)
    private String status;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Column(name = "expires_at", nullable = false)
    private Instant expiresAt;

    protected QuotaReservationEntity() {
    }

    public static QuotaReservationEntity from(QuotaReservation reservation) {
        QuotaReservationEntity entity = new QuotaReservationEntity();
        entity.id = reservation.id();
        entity.workspaceId = reservation.workspaceId();
        entity.uploadId = reservation.uploadId();
        entity.sizeBytes = reservation.sizeBytes();
        entity.status = reservation.status().name();
        entity.createdAt = reservation.createdAt();
        entity.updatedAt = reservation.updatedAt();
        entity.expiresAt = reservation.expiresAt();
        return entity;
    }

    public QuotaReservation toDomain() {
        return new QuotaReservation(id, workspaceId, uploadId, sizeBytes,
                ReservationStatus.valueOf(status), createdAt, updatedAt, expiresAt);
    }

    public UUID getId() {
        return id;
    }

    public UUID getWorkspaceId() {
        return workspaceId;
    }

    public UUID getUploadId() {
        return uploadId;
    }

    public Long getSizeBytes() {
        return sizeBytes;
    }

    public String getStatus() {
        return status;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }

    public Instant getExpiresAt() {
        return expiresAt;
    }
}
