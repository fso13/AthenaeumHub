package ru.krug.backend.workspace.infrastructure.persistence;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "workspaces", schema = "workspace")
public class WorkspaceEntity {

    @Id
    private UUID id;

    @Column(name = "name", nullable = false)
    private String name;

    @Column(name = "slug", nullable = false)
    private String slug;

    @Column(name = "description")
    private String description;

    @Column(name = "logo_file_id")
    private UUID logoFileId;

    @Column(name = "security_mode", nullable = false)
    private String securityMode;

    @Column(name = "status", nullable = false)
    private String status;

    @Column(name = "created_by")
    private UUID createdBy;

    @Column(name = "created_at", insertable = false, updatable = false)
    private Instant createdAt;

    protected WorkspaceEntity() {
    }

    public UUID getId() {
        return id;
    }

    public String getName() {
        return name;
    }

    public String getSlug() {
        return slug;
    }

    public String getDescription() {
        return description;
    }

    public UUID getLogoFileId() {
        return logoFileId;
    }

    public String getSecurityMode() {
        return securityMode;
    }

    public String getStatus() {
        return status;
    }

    public UUID getCreatedBy() {
        return createdBy;
    }
}
