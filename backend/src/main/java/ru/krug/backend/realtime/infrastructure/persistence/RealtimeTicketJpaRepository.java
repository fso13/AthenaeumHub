package ru.krug.backend.realtime.infrastructure.persistence;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface RealtimeTicketJpaRepository
        extends JpaRepository<RealtimeTicketEntity, UUID> {

    Optional<RealtimeTicketEntity> findByTokenHash(String tokenHash);

    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query(value = """
            UPDATE realtime.realtime_tickets
               SET consumed_at = :now
             WHERE id = :id
               AND consumed_at IS NULL
               AND expires_at > :now
            """, nativeQuery = true)
    int consume(@Param("id") UUID id, @Param("now") Instant now);

    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query(value = """
            DELETE FROM realtime.realtime_tickets
             WHERE ctid IN (
                   SELECT ctid FROM realtime.realtime_tickets
                    WHERE expires_at < :cutoff
                       OR (consumed_at IS NOT NULL AND consumed_at < :cutoff)
                    ORDER BY expires_at
                    LIMIT :batchSize
             )
            """, nativeQuery = true)
    int deleteExpired(@Param("cutoff") Instant cutoff, @Param("batchSize") int batchSize);
}
