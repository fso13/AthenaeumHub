package ru.krug.backend.auth.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * Per-user TOTP authenticator (P0-4 / #82). The secret is held in memory as base64url and
 * is encrypted by the repository adapter before it reaches PostgreSQL. {@code toString()}
 * is deliberately not generated: a record would leak the secret into logs.
 *
 * <p>{@code enabledAt == null} means "setup started, not confirmed"; the secret is not
 * accepted at login until {@code /me/2fa/verify} succeeds.</p>
 */
public final class TwoFactorSettings {

    private final UUID userId;
    private final String secret;
    private final Instant enabledAt;
    private final long lastUsedStep;
    private final Instant createdAt;
    private final Instant updatedAt;

    private TwoFactorSettings(UUID userId, String secret, Instant enabledAt, long lastUsedStep,
                              Instant createdAt, Instant updatedAt) {
        this.userId = Objects.requireNonNull(userId, "userId");
        if (secret == null || secret.isBlank()) {
            throw new IllegalArgumentException("TOTP secret is required");
        }
        if (lastUsedStep < 0) {
            throw new IllegalArgumentException("lastUsedStep must be >= 0");
        }
        this.secret = secret;
        this.enabledAt = enabledAt;
        this.lastUsedStep = lastUsedStep;
        this.createdAt = Objects.requireNonNull(createdAt, "createdAt");
        this.updatedAt = Objects.requireNonNull(updatedAt, "updatedAt");
    }

    public static TwoFactorSettings pending(UUID userId, String secret, Instant now) {
        return new TwoFactorSettings(userId, secret, null, 0L, now, now);
    }

    public static TwoFactorSettings reconstitute(UUID userId, String secret, Instant enabledAt,
                                                 long lastUsedStep, Instant createdAt,
                                                 Instant updatedAt) {
        return new TwoFactorSettings(userId, secret, enabledAt, lastUsedStep, createdAt,
                updatedAt);
    }

    public TwoFactorSettings enabled(Instant at) {
        return new TwoFactorSettings(userId, secret, Objects.requireNonNull(at), lastUsedStep,
                createdAt, at);
    }

    public TwoFactorSettings withLastUsedStep(long step, Instant at) {
        if (step <= lastUsedStep) {
            return this;
        }
        return new TwoFactorSettings(userId, secret, enabledAt, step, createdAt, at);
    }

    public boolean isEnabled() {
        return enabledAt != null;
    }

    public UUID userId() {
        return userId;
    }

    /** Plaintext secret; never log or serialise this value. */
    public String secret() {
        return secret;
    }

    public Instant enabledAt() {
        return enabledAt;
    }

    public long lastUsedStep() {
        return lastUsedStep;
    }

    public Instant createdAt() {
        return createdAt;
    }

    public Instant updatedAt() {
        return updatedAt;
    }

    @Override
    public String toString() {
        return "TwoFactorSettings[userId=" + userId + ", enabled=" + isEnabled()
                + ", lastUsedStep=" + lastUsedStep + "]";
    }
}
