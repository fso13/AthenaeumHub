package ru.krug.backend.file.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * Reservation aggregate. Exactly one of the terminal transitions (commit/release/expire)
 * may happen; every transition is guarded so a retry cannot double-count quota.
 */
public record QuotaReservation(
        UUID id,
        UUID workspaceId,
        UUID uploadId,
        long sizeBytes,
        ReservationStatus status,
        Instant createdAt,
        Instant updatedAt,
        Instant expiresAt) {

    public QuotaReservation {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(workspaceId, "workspaceId");
        Objects.requireNonNull(uploadId, "uploadId");
        Objects.requireNonNull(status, "status");
        Objects.requireNonNull(createdAt, "createdAt");
        Objects.requireNonNull(updatedAt, "updatedAt");
        Objects.requireNonNull(expiresAt, "expiresAt");
        if (sizeBytes <= 0) {
            throw new IllegalArgumentException("reservation size must be > 0");
        }
    }

    public static QuotaReservation active(UUID id, UUID workspaceId, UUID uploadId,
                                          long sizeBytes, Instant now, Instant expiresAt) {
        return new QuotaReservation(id, workspaceId, uploadId, sizeBytes,
                ReservationStatus.ACTIVE, now, now, expiresAt);
    }

    public QuotaReservation commit(Instant now) {
        require(ReservationStatus.ACTIVE, "commit");
        return new QuotaReservation(id, workspaceId, uploadId, sizeBytes,
                ReservationStatus.COMMITTED, createdAt, now, expiresAt);
    }

    public QuotaReservation release(Instant now) {
        if (status != ReservationStatus.ACTIVE && status != ReservationStatus.COMMITTED) {
            throw new IllegalStateException("cannot release reservation in status " + status);
        }
        return new QuotaReservation(id, workspaceId, uploadId, sizeBytes,
                ReservationStatus.RELEASED, createdAt, now, expiresAt);
    }

    public QuotaReservation expire(Instant now) {
        require(ReservationStatus.ACTIVE, "expire");
        return new QuotaReservation(id, workspaceId, uploadId, sizeBytes,
                ReservationStatus.EXPIRED, createdAt, now, expiresAt);
    }

    public boolean isActive() {
        return status == ReservationStatus.ACTIVE;
    }

    public boolean isCommitted() {
        return status == ReservationStatus.COMMITTED;
    }

    private void require(ReservationStatus expected, String action) {
        if (status != expected) {
            throw new IllegalStateException(
                    "cannot " + action + " reservation in status " + status);
        }
    }
}
