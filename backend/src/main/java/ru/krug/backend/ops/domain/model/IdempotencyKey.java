package ru.krug.backend.ops.domain.model;

import java.time.Duration;
import java.time.Instant;
import java.util.Arrays;
import java.util.Objects;
import java.util.UUID;

/**
 * Idempotency record. status == null means "request in progress"; a concurrent duplicate
 * must observe it and get 409 IDEMPOTENCY_IN_PROGRESS.
 */
public final class IdempotencyKey {

    /** SYSTEM-ANALYSIS §7.3: Idempotency-Key lives for 24 hours. */
    public static final Duration TTL = Duration.ofHours(24);

    private final UUID userId;
    private final String scope;
    private final String key;
    private final byte[] requestHash;
    private final Integer status;
    private final UUID resourceId;
    private final Instant createdAt;
    private final Instant expiresAt;

    private IdempotencyKey(UUID userId, String scope, String key, byte[] requestHash,
                           Integer status, UUID resourceId, Instant createdAt, Instant expiresAt) {
        this.userId = Objects.requireNonNull(userId, "userId");
        this.scope = Objects.requireNonNull(scope, "scope");
        this.key = Objects.requireNonNull(key, "key");
        this.requestHash = Objects.requireNonNull(requestHash, "requestHash");
        this.status = status;
        this.resourceId = resourceId;
        this.createdAt = Objects.requireNonNull(createdAt, "createdAt");
        this.expiresAt = Objects.requireNonNull(expiresAt, "expiresAt");
    }

    public static IdempotencyKey inProgress(UUID userId, String scope, String key,
                                            byte[] requestHash, Instant createdAt) {
        return new IdempotencyKey(userId, scope, key, requestHash, null, null, createdAt,
                createdAt.plus(TTL));
    }

    /**
     * A completed record. The upsert that stores it is also used to recover a key whose
     * original transaction rolled back (client_message_id race), so the factory carries
     * the request hash rather than assuming an existing row.
     */
    public static IdempotencyKey completed(UUID userId, String scope, String key,
                                           byte[] requestHash, int status, UUID resourceId,
                                           Instant createdAt) {
        return new IdempotencyKey(userId, scope, key, requestHash, status, resourceId,
                createdAt, createdAt.plus(TTL));
    }

    public static IdempotencyKey reconstitute(UUID userId, String scope, String key,
                                              byte[] requestHash, Integer status,
                                              UUID resourceId, Instant createdAt,
                                              Instant expiresAt) {
        return new IdempotencyKey(userId, scope, key, requestHash, status, resourceId, createdAt,
                expiresAt);
    }

    public boolean matches(byte[] hash) {
        return Arrays.equals(requestHash, hash);
    }

    public boolean isExpired(Instant now) {
        return expiresAt.isBefore(now);
    }

    public boolean isInProgress() {
        return status == null;
    }

    public UUID userId() {
        return userId;
    }

    public String scope() {
        return scope;
    }

    public String key() {
        return key;
    }

    public byte[] requestHash() {
        return requestHash;
    }

    public Integer status() {
        return status;
    }

    public UUID resourceId() {
        return resourceId;
    }

    public Instant createdAt() {
        return createdAt;
    }

    public Instant expiresAt() {
        return expiresAt;
    }
}
