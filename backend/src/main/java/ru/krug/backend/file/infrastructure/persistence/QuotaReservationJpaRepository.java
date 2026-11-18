package ru.krug.backend.file.infrastructure.persistence;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.LockModeType;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface QuotaReservationJpaRepository
        extends JpaRepository<QuotaReservationEntity, UUID> {

    Optional<QuotaReservationEntity> findByUploadId(UUID uploadId);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select r from QuotaReservationEntity r where r.uploadId = :uploadId")
    Optional<QuotaReservationEntity> findForUpdateByUploadId(@Param("uploadId") UUID uploadId);

    List<QuotaReservationEntity> findByStatusAndExpiresAtBefore(String status, Instant now,
                                                                org.springframework.data.domain.Pageable pageable);
}
