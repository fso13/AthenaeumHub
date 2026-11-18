package ru.krug.backend.ops.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.ops.domain.model.OutboxMessage;
import ru.krug.backend.ops.domain.model.OutboxRecord;
import ru.krug.backend.ops.domain.repository.OutboxRepository;

@Repository
public class OutboxRepositoryAdapter implements OutboxRepository {

    private final EntityManager entityManager;

    public OutboxRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public void save(OutboxMessage message) {
        entityManager.persist(OutboxEntity.create(message.workspaceId(), message.aggregateType(),
                message.aggregateId(), message.eventType(), message.eventVersion(),
                message.partitionKey(), message.payload(), message.occurredAt()));
    }

    @Override
    public List<OutboxRecord> lockUnpublished(int batchSize) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT id, workspace_id, event_type, aggregate_id, partition_key
                          FROM ops.outbox
                         WHERE published_at IS NULL
                         ORDER BY id
                         FOR UPDATE SKIP LOCKED
                         LIMIT ?1
                        """)
                .setParameter(1, batchSize)
                .getResultList();
        return rows.stream().map(row -> new OutboxRecord(
                ((Number) row[0]).longValue(),
                (UUID) row[1],
                (String) row[2],
                (UUID) row[3],
                (String) row[4])).toList();
    }

    @Override
    public void markPublished(long id, Instant at) {
        entityManager.createNativeQuery("""
                        UPDATE ops.outbox SET published_at = ?2 WHERE id = ?1
                        """)
                .setParameter(1, id)
                .setParameter(2, Timestamp.from(at))
                .executeUpdate();
    }

    @Override
    public int deletePublishedBefore(Instant cutoff, int batchSize) {
        return entityManager.createNativeQuery("""
                        DELETE FROM ops.outbox
                         WHERE ctid IN (
                               SELECT ctid FROM ops.outbox
                                WHERE published_at IS NOT NULL
                                  AND published_at < ?1
                                ORDER BY id
                                LIMIT ?2
                         )
                        """)
                .setParameter(1, Timestamp.from(cutoff))
                .setParameter(2, batchSize)
                .executeUpdate();
    }
}
