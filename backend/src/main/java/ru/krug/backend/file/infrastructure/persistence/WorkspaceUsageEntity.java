package ru.krug.backend.file.infrastructure.persistence;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import ru.krug.backend.file.domain.model.QuotaUsage;

@Entity
@Table(name = "workspace_usage", schema = "file")
public class WorkspaceUsageEntity {

    @Id
    @Column(name = "workspace_id")
    private UUID workspaceId;

    @Column(name = "used_bytes", nullable = false)
    private Long usedBytes;

    @Column(name = "reserved_bytes", nullable = false)
    private Long reservedBytes;

    @Column(name = "version", nullable = false)
    private Integer version;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected WorkspaceUsageEntity() {
    }

    public static WorkspaceUsageEntity from(UUID workspaceId, QuotaUsage usage) {
        WorkspaceUsageEntity entity = new WorkspaceUsageEntity();
        entity.workspaceId = workspaceId;
        entity.usedBytes = usage.used();
        entity.reservedBytes = usage.reserved();
        entity.version = 1;
        entity.updatedAt = Instant.now();
        return entity;
    }

    public QuotaUsage toDomain() {
        return new QuotaUsage(usedBytes, reservedBytes);
    }

    public UUID getWorkspaceId() {
        return workspaceId;
    }

    public Long getUsedBytes() {
        return usedBytes;
    }

    public Long getReservedBytes() {
        return reservedBytes;
    }
}
