package ru.krug.backend.auth.infrastructure.persistence;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "user_identities", schema = "auth")
public class UserIdentityEntity {

    @Id
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(name = "provider", nullable = false)
    private String provider;

    @Column(name = "subject", nullable = false)
    private String subject;

    @Column(name = "created_at", insertable = false, updatable = false)
    private Instant createdAt;

    protected UserIdentityEntity() {
    }

    public UUID getId() {
        return id;
    }

    public UUID getUserId() {
        return userId;
    }

    public String getProvider() {
        return provider;
    }

    public String getSubject() {
        return subject;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}
