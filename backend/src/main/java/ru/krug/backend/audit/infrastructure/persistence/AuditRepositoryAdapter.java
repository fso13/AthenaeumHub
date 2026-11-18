package ru.krug.backend.audit.infrastructure.persistence;

import java.sql.Timestamp;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.audit.domain.model.AuditChainHead;
import ru.krug.backend.audit.domain.model.AuditEvent;
import ru.krug.backend.audit.domain.repository.AuditRepository;

/**
 * Audit persistence. Events are append-only (the runtime role has only SELECT/INSERT on
 * {@code audit.audit_events}), so the append is a plain INSERT instead of a JPA persist:
 * a managed entity would be flushed a second time at commit, and Hibernate's JSON
 * dirty-check can see a numeric {@code metadata} value as changed and emit an UPDATE that
 * the database rejects. The chain head is updated in the same transaction.
 */
@Repository
public class AuditRepositoryAdapter implements AuditRepository {

    private final EntityManager entityManager;
    private final ObjectMapper objectMapper;

    public AuditRepositoryAdapter(EntityManager entityManager, ObjectMapper objectMapper) {
        this.entityManager = entityManager;
        this.objectMapper = objectMapper;
    }

    @Override
    public AuditChainHead lockOrCreate(String scopeKey) {
        entityManager.createNativeQuery("""
                        INSERT INTO audit.audit_chain (scope_key, last_seq, last_hash)
                        VALUES (?1, 0, ?2)
                        ON CONFLICT (scope_key) DO NOTHING
                        """)
                .setParameter(1, scopeKey)
                .setParameter(2, AuditChainHead.GENESIS_HASH)
                .executeUpdate();

        Object[] row = (Object[]) entityManager.createNativeQuery("""
                        SELECT last_seq, last_hash
                          FROM audit.audit_chain
                         WHERE scope_key = ?1
                         FOR UPDATE
                        """)
                .setParameter(1, scopeKey)
                .getSingleResult();
        return new AuditChainHead(scopeKey, ((Number) row[0]).longValue(), (byte[]) row[1]);
    }

    @Override
    public void append(AuditEvent event) {
        entityManager.createNativeQuery("""
                        INSERT INTO audit.audit_events
                               (id, scope_key, workspace_id, seq, actor_type, actor_id,
                                action, target_type, target_id, request_id, metadata,
                                prev_hash, hash, created_at)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                                CAST(?11 AS jsonb), ?12, ?13, ?14)
                        """)
                .setParameter(1, event.id())
                .setParameter(2, event.scopeKey())
                .setParameter(3, event.workspaceId())
                .setParameter(4, event.seq())
                .setParameter(5, event.actorType())
                .setParameter(6, event.actorId())
                .setParameter(7, event.action())
                .setParameter(8, event.targetType())
                .setParameter(9, event.targetId())
                .setParameter(10, event.requestId())
                .setParameter(11, metadataJson(event))
                .setParameter(12, event.prevHash())
                .setParameter(13, event.hash())
                .setParameter(14, Timestamp.from(event.createdAt()))
                .executeUpdate();
    }

    @Override
    public void updateHead(String scopeKey, long lastSeq, byte[] lastHash) {
        entityManager.createNativeQuery("""
                        UPDATE audit.audit_chain
                           SET last_seq = ?2,
                               last_hash = ?3,
                               updated_at = now()
                         WHERE scope_key = ?1
                        """)
                .setParameter(1, scopeKey)
                .setParameter(2, lastSeq)
                .setParameter(3, lastHash)
                .executeUpdate();
    }

    private String metadataJson(AuditEvent event) {
        try {
            return objectMapper.writeValueAsString(event.metadata());
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("Cannot serialise audit metadata", ex);
        }
    }
}
