package ru.krug.backend.file.infrastructure.persistence;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Repository;

import ru.krug.backend.file.domain.model.QuotaReservation;
import ru.krug.backend.file.domain.repository.QuotaReservationRepository;

@Repository
public class QuotaReservationRepositoryAdapter implements QuotaReservationRepository {

    private final QuotaReservationJpaRepository jpaRepository;
    private final EntityManager entityManager;

    public QuotaReservationRepositoryAdapter(QuotaReservationJpaRepository jpaRepository,
                                             EntityManager entityManager) {
        this.jpaRepository = jpaRepository;
        this.entityManager = entityManager;
    }

    @Override
    public void save(QuotaReservation reservation) {
        entityManager.merge(QuotaReservationEntity.from(reservation));
    }

    @Override
    public Optional<QuotaReservation> findByUploadId(UUID uploadId) {
        return jpaRepository.findByUploadId(uploadId).map(QuotaReservationEntity::toDomain);
    }

    @Override
    public Optional<QuotaReservation> findForUpdateByUploadId(UUID uploadId) {
        return jpaRepository.findForUpdateByUploadId(uploadId)
                .map(QuotaReservationEntity::toDomain);
    }

    @Override
    public List<QuotaReservation> findActiveExpired(Instant now, int limit) {
        return jpaRepository.findByStatusAndExpiresAtBefore("ACTIVE", now,
                        PageRequest.of(0, limit)).stream()
                .map(QuotaReservationEntity::toDomain).toList();
    }
}
