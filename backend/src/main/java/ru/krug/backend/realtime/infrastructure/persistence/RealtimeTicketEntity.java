package ru.krug.backend.realtime.infrastructure.persistence;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/** JPA mapping of realtime.realtime_tickets. The raw ticket is not persisted. */
@Entity
@Table(name = "realtime_tickets", schema = "realtime")
public class RealtimeTicketEntity {

    @Id
    private UUID id;

    @Column(name = "token_hash", nullable = false, unique = true, length = 64)
    private String tokenHash;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(name = "device_id", nullable = false)
    private UUID deviceId;

    @Column(name = "workspace_id")
    private UUID workspaceId;

    @Column(name = "issued_at", nullable = false)
    private Instant issuedAt;

    @Column(name = "expires_at", nullable = false)
    private Instant expiresAt;

    @Column(name = "consumed_at")
    private Instant consumedAt;

    protected RealtimeTicketEntity() {
    }

    public RealtimeTicketEntity(UUID id, String tokenHash, UUID userId, UUID deviceId,
                                UUID workspaceId, Instant issuedAt, Instant expiresAt,
                                Instant consumedAt) {
        this.id = id;
        this.tokenHash = tokenHash;
        this.userId = userId;
        this.deviceId = deviceId;
        this.workspaceId = workspaceId;
        this.issuedAt = issuedAt;
        this.expiresAt = expiresAt;
        this.consumedAt = consumedAt;
    }

    public UUID getId() {
        return id;
    }

    public String getTokenHash() {
        return tokenHash;
    }

    public UUID getUserId() {
        return userId;
    }

    public UUID getDeviceId() {
        return deviceId;
    }

    public UUID getWorkspaceId() {
        return workspaceId;
    }

    public Instant getIssuedAt() {
        return issuedAt;
    }

    public Instant getExpiresAt() {
        return expiresAt;
    }

    public Instant getConsumedAt() {
        return consumedAt;
    }
}
