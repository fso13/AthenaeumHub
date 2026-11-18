package ru.krug.backend.audit.infrastructure.persistence;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

@Entity
@Table(name = "audit_events", schema = "audit")
public class AuditEventEntity {

    @Id
    private UUID id;

    @Column(name = "scope_key", nullable = false)
    private String scopeKey;

    @Column(name = "workspace_id")
    private UUID workspaceId;

    @Column(name = "seq", nullable = false)
    private Long seq;

    @Column(name = "actor_type", nullable = false)
    private String actorType;

    @Column(name = "actor_id")
    private UUID actorId;

    @Column(name = "action", nullable = false)
    private String action;

    @Column(name = "target_type")
    private String targetType;

    @Column(name = "target_id")
    private UUID targetId;

    @Column(name = "request_id")
    private String requestId;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "metadata", columnDefinition = "jsonb", nullable = false)
    private Map<String, Object> metadata;

    @Column(name = "prev_hash", nullable = false)
    private byte[] prevHash;

    @Column(name = "hash", nullable = false)
    private byte[] hash;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected AuditEventEntity() {
    }

    public static AuditEventEntity create(UUID id, String scopeKey, UUID workspaceId, long seq,
                                          String actorType, UUID actorId, String action,
                                          String targetType, UUID targetId, String requestId,
                                          Map<String, Object> metadata, byte[] prevHash,
                                          byte[] hash, Instant createdAt) {
        AuditEventEntity entity = new AuditEventEntity();
        entity.id = id;
        entity.scopeKey = scopeKey;
        entity.workspaceId = workspaceId;
        entity.seq = seq;
        entity.actorType = actorType;
        entity.actorId = actorId;
        entity.action = action;
        entity.targetType = targetType;
        entity.targetId = targetId;
        entity.requestId = requestId;
        entity.metadata = metadata;
        entity.prevHash = prevHash;
        entity.hash = hash;
        entity.createdAt = createdAt;
        return entity;
    }
}
