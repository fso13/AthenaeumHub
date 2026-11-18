package ru.krug.backend.auth.infrastructure.persistence;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.LockModeType;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

interface EmailVerificationJpaRepository
        extends JpaRepository<EmailVerificationEntity, UUID> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select e from EmailVerificationEntity e where e.id = :id")
    Optional<EmailVerificationEntity> lockById(@Param("id") UUID id);

    Optional<EmailVerificationEntity>
            findFirstByEmailIgnoreCaseAndConsumedAtIsNullAndExpiresAtAfterOrderByCreatedAtDesc(
                    String email, Instant now);

    List<EmailVerificationEntity>
            findByExpiresAtBeforeAndConsumedAtIsNullOrderByExpiresAtAsc(Instant now,
                                                                        Pageable pageable);

    @Modifying
    @Query("""
            update EmailVerificationEntity e
               set e.consumedAt = :now
             where e.id = :id and e.consumedAt is null
            """)
    int markConsumed(@Param("id") UUID id, @Param("now") Instant now);

    @Modifying
    @Query(value = """
            DELETE FROM auth.email_verifications
             WHERE id IN (
               SELECT id FROM auth.email_verifications
                WHERE consumed_at IS NOT NULL AND consumed_at < :cutoff
                LIMIT :limit
             )
            """, nativeQuery = true)
    int deleteConsumedBefore(@Param("cutoff") Instant cutoff, @Param("limit") int limit);
}
