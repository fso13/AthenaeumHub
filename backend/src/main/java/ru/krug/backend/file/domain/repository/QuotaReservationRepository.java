package ru.krug.backend.file.domain.repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.file.domain.model.QuotaReservation;

public interface QuotaReservationRepository {

    void save(QuotaReservation reservation);

    Optional<QuotaReservation> findByUploadId(UUID uploadId);

    Optional<QuotaReservation> findForUpdateByUploadId(UUID uploadId);

    List<QuotaReservation> findActiveExpired(Instant now, int limit);
}
