package ru.krug.backend.file.infrastructure.persistence;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import ru.krug.backend.file.domain.model.Tariff;
import ru.krug.backend.file.domain.model.WorkspaceLimits;

@Entity
@Table(name = "workspace_limits", schema = "file")
public class WorkspaceLimitsEntity {

    @Id
    @Column(name = "workspace_id")
    private UUID workspaceId;

    @Column(name = "tariff", nullable = false)
    private String tariff;

    @Column(name = "max_file_bytes", nullable = false)
    private Long maxFileBytes;

    @Column(name = "storage_bytes", nullable = false)
    private Long storageBytes;

    @Column(name = "max_attachments", nullable = false)
    private Integer maxAttachments;

    @Column(name = "guest_file_bytes", nullable = false)
    private Long guestFileBytes;

    @Column(name = "retention_months", nullable = false)
    private Integer retentionMonths;

    @Column(name = "created_at", insertable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", insertable = false, updatable = false)
    private Instant updatedAt;

    protected WorkspaceLimitsEntity() {
    }

    public static WorkspaceLimitsEntity from(WorkspaceLimits limits) {
        WorkspaceLimitsEntity entity = new WorkspaceLimitsEntity();
        entity.workspaceId = limits.workspaceId();
        entity.tariff = limits.tariff().name();
        entity.maxFileBytes = limits.maxFileBytes();
        entity.storageBytes = limits.storageBytes();
        entity.maxAttachments = limits.maxAttachments();
        entity.guestFileBytes = limits.guestFileBytes();
        entity.retentionMonths = limits.retentionMonths();
        return entity;
    }

    public WorkspaceLimits toDomain() {
        return new WorkspaceLimits(workspaceId, Tariff.from(tariff), maxFileBytes, storageBytes,
                maxAttachments, guestFileBytes, retentionMonths);
    }

    public UUID getWorkspaceId() {
        return workspaceId;
    }
}
