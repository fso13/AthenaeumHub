package ru.krug.backend.realtime.domain.model;

import java.time.Duration;
import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * One-time realtime ticket aggregate. The secret itself is not part of the aggregate:
 * only its hash is stored, while the raw token is returned to the client exactly once.
 */
public final class RealtimeTicket {

    private static final Duration MAX_TTL = Duration.ofMinutes(5);

    private final TicketId id;
    private final TicketTokenHash tokenHash;
    private final UUID userId;
    private final UUID deviceId;
    private final UUID workspaceId;
    private final Instant issuedAt;
    private final Instant expiresAt;
    private final Instant consumedAt;

    private RealtimeTicket(TicketId id, TicketTokenHash tokenHash, UUID userId, UUID deviceId,
                           UUID workspaceId, Instant issuedAt, Instant expiresAt,
                           Instant consumedAt) {
        this.id = Objects.requireNonNull(id, "id");
        this.tokenHash = Objects.requireNonNull(tokenHash, "tokenHash");
        this.userId = Objects.requireNonNull(userId, "userId");
        this.deviceId = Objects.requireNonNull(deviceId, "deviceId");
        this.workspaceId = workspaceId;
        this.issuedAt = Objects.requireNonNull(issuedAt, "issuedAt");
        this.expiresAt = Objects.requireNonNull(expiresAt, "expiresAt");
        if (!expiresAt.isAfter(issuedAt)) {
            throw new IllegalArgumentException("expiresAt must be after issuedAt");
        }
        if (consumedAt != null && consumedAt.isBefore(issuedAt)) {
            throw new IllegalArgumentException("consumedAt must not precede issuedAt");
        }
        this.consumedAt = consumedAt;
    }

    public static RealtimeTicket issue(TicketId id, TicketTokenHash tokenHash, UUID userId,
                                       UUID deviceId, UUID workspaceId, Instant issuedAt,
                                       Duration ttl) {
        Objects.requireNonNull(ttl, "ttl");
        if (ttl.isZero() || ttl.isNegative()) {
            throw new IllegalArgumentException("ticket ttl must be positive");
        }
        if (ttl.compareTo(MAX_TTL) > 0) {
            throw new IllegalArgumentException("ticket ttl must not exceed 5 minutes");
        }
        return new RealtimeTicket(id, tokenHash, userId, deviceId, workspaceId, issuedAt,
                issuedAt.plus(ttl), null);
    }

    public static RealtimeTicket reconstitute(TicketId id, TicketTokenHash tokenHash,
                                              UUID userId, UUID deviceId, UUID workspaceId,
                                              Instant issuedAt, Instant expiresAt,
                                              Instant consumedAt) {
        return new RealtimeTicket(id, tokenHash, userId, deviceId, workspaceId, issuedAt,
                expiresAt, consumedAt);
    }

    public boolean isExpired(Instant now) {
        Objects.requireNonNull(now, "now");
        return !now.isBefore(expiresAt);
    }

    public boolean isConsumed() {
        return consumedAt != null;
    }

    public boolean isUsable(Instant now) {
        return !isConsumed() && !isExpired(now);
    }

    public TicketId id() {
        return id;
    }

    public TicketTokenHash tokenHash() {
        return tokenHash;
    }

    public UUID userId() {
        return userId;
    }

    public UUID deviceId() {
        return deviceId;
    }

    public UUID workspaceId() {
        return workspaceId;
    }

    public Instant issuedAt() {
        return issuedAt;
    }

    public Instant expiresAt() {
        return expiresAt;
    }

    public Instant consumedAt() {
        return consumedAt;
    }
}
