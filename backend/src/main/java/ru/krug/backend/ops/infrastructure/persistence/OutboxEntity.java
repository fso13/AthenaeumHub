package ru.krug.backend.ops.infrastructure.persistence;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

@Entity
@Table(name = "outbox", schema = "ops")
public class OutboxEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "workspace_id", nullable = false)
    private UUID workspaceId;

    @Column(name = "aggregate_type", nullable = false)
    private String aggregateType;

    @Column(name = "aggregate_id", nullable = false)
    private UUID aggregateId;

    @Column(name = "event_type", nullable = false)
    private String eventType;

    @Column(name = "event_version", nullable = false)
    private Integer eventVersion;

    @Column(name = "partition_key", nullable = false)
    private String partitionKey;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "payload", columnDefinition = "jsonb", nullable = false)
    private Map<String, Object> payload;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected OutboxEntity() {
    }

    private OutboxEntity(UUID workspaceId, String aggregateType, UUID aggregateId,
                         String eventType, Integer eventVersion, String partitionKey,
                         Map<String, Object> payload, Instant createdAt) {
        this.workspaceId = workspaceId;
        this.aggregateType = aggregateType;
        this.aggregateId = aggregateId;
        this.eventType = eventType;
        this.eventVersion = eventVersion;
        this.partitionKey = partitionKey;
        this.payload = payload;
        this.createdAt = createdAt;
    }

    public static OutboxEntity create(UUID workspaceId, String aggregateType, UUID aggregateId,
                                      String eventType, Integer eventVersion, String partitionKey,
                                      Map<String, Object> payload, Instant createdAt) {
        return new OutboxEntity(workspaceId, aggregateType, aggregateId, eventType, eventVersion,
                partitionKey, payload, createdAt);
    }

    public Long getId() {
        return id;
    }
}
