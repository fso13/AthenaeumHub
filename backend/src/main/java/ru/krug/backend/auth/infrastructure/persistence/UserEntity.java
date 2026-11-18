package ru.krug.backend.auth.infrastructure.persistence;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/**
 * JPA persistence model; deliberately separate from the domain aggregate.
 */
@Entity
@Table(name = "users", schema = "auth")
public class UserEntity {

    @Id
    private UUID id;

    @Column(name = "email")
    private String email;

    @Column(name = "display_name", nullable = false)
    private String displayName;

    @Column(name = "status", nullable = false)
    private String status;

    @Column(name = "is_platform_admin", nullable = false)
    private boolean platformAdmin;

    @Column(name = "created_at", insertable = false, updatable = false)
    private Instant createdAt;

    protected UserEntity() {
    }

    public UUID getId() {
        return id;
    }

    public String getEmail() {
        return email;
    }

    public String getDisplayName() {
        return displayName;
    }

    public String getStatus() {
        return status;
    }

    public boolean isPlatformAdmin() {
        return platformAdmin;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}
