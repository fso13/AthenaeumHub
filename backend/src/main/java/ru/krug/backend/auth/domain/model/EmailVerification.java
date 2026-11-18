package ru.krug.backend.auth.domain.model;

import java.time.Duration;
import java.time.Instant;
import java.util.Locale;
import java.util.Objects;
import java.util.UUID;

/**
 * Pending email confirmation. Holds the encrypted-at-rest TOTP secret (the repository
 * adapter encrypts/decrypts), never a password or the 6-digit code itself.
 */
public final class EmailVerification {

    private final UUID id;
    private final String email;
    private final String displayName;
    private final UUID keycloakUserId;
    private final String secret;
    private final Instant expiresAt;
    private final int attempts;
    private final Instant consumedAt;
    private final Instant lastSentAt;
    private final Instant createdAt;

    private EmailVerification(UUID id, String email, String displayName, UUID keycloakUserId,
                              String secret, Instant expiresAt, int attempts, Instant consumedAt,
                              Instant lastSentAt, Instant createdAt) {
        this.id = Objects.requireNonNull(id, "id");
        this.email = normalizeEmail(email);
        this.displayName = requireDisplayName(displayName);
        this.keycloakUserId = Objects.requireNonNull(keycloakUserId, "keycloakUserId");
        this.secret = requireSecret(secret);
        this.expiresAt = Objects.requireNonNull(expiresAt, "expiresAt");
        this.attempts = attempts;
        this.consumedAt = consumedAt;
        this.lastSentAt = Objects.requireNonNull(lastSentAt, "lastSentAt");
        this.createdAt = Objects.requireNonNull(createdAt, "createdAt");
        if (attempts < 0) {
            throw new IllegalArgumentException("attempts must be >= 0");
        }
        if (!expiresAt.isAfter(createdAt)) {
            throw new IllegalArgumentException("expiresAt must be after createdAt");
        }
    }

    public static EmailVerification create(UUID id, String email, String displayName,
                                           UUID keycloakUserId, String secret,
                                           Instant expiresAt, Instant now) {
        return new EmailVerification(id, email, displayName, keycloakUserId, secret, expiresAt,
                0, null, now, now);
    }

    public static EmailVerification reconstitute(UUID id, String email, String displayName,
                                                 UUID keycloakUserId, String secret,
                                                 Instant expiresAt, int attempts,
                                                 Instant consumedAt, Instant lastSentAt,
                                                 Instant createdAt) {
        return new EmailVerification(id, email, displayName, keycloakUserId, secret, expiresAt,
                attempts, consumedAt, lastSentAt, createdAt);
    }

    public UUID id() {
        return id;
    }

    public String email() {
        return email;
    }

    public String displayName() {
        return displayName;
    }

    public UUID keycloakUserId() {
        return keycloakUserId;
    }

    public String secret() {
        return secret;
    }

    public Instant expiresAt() {
        return expiresAt;
    }

    public int attempts() {
        return attempts;
    }

    public Instant consumedAt() {
        return consumedAt;
    }

    public Instant lastSentAt() {
        return lastSentAt;
    }

    public Instant createdAt() {
        return createdAt;
    }

    public boolean isConsumed() {
        return consumedAt != null;
    }

    public boolean isExpired(Instant now) {
        return !now.isBefore(expiresAt);
    }

    public boolean isLocked(int maxAttempts) {
        return attempts >= maxAttempts;
    }

    public boolean canResend(Instant now, Duration cooldown) {
        return !now.isBefore(lastSentAt.plus(cooldown));
    }

    public long secondsUntilExpiry(Instant now) {
        long seconds = Duration.between(now, expiresAt).toSeconds();
        return Math.max(0, seconds);
    }

    public EmailVerification withFailedAttempt() {
        return new EmailVerification(id, email, displayName, keycloakUserId, secret, expiresAt,
                attempts + 1, consumedAt, lastSentAt, createdAt);
    }

    /** Rotates the secret and records the send time; the expiration window is unchanged. */
    public EmailVerification withNewSecret(String newSecret, Instant sentAt) {
        return new EmailVerification(id, email, displayName, keycloakUserId, newSecret, expiresAt,
                attempts, consumedAt, sentAt, createdAt);
    }

    public EmailVerification consumed(Instant at) {
        return new EmailVerification(id, email, displayName, keycloakUserId, secret, expiresAt,
                attempts, at, lastSentAt, createdAt);
    }

    public static String normalizeEmail(String value) {
        if (value == null) {
            return null;
        }
        return value.strip().toLowerCase(Locale.ROOT);
    }

    private static String requireDisplayName(String value) {
        String normalized = value == null ? null : value.strip();
        if (normalized == null || normalized.isEmpty() || normalized.length() > 80) {
            throw new IllegalArgumentException("displayName must be 1..80 characters");
        }
        return normalized;
    }

    private static String requireSecret(String value) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("secret is required");
        }
        return value;
    }
}
