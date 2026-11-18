package ru.krug.backend.auth.domain.model;

import java.time.Instant;
import java.util.Arrays;
import java.util.Objects;
import java.util.UUID;

/**
 * auth device aggregate. E7-B1 extends the B-01 device with the two E2EE identity keys,
 * the binding signature, a fingerprint and a key generation.
 *
 * <p>Legacy devices (registered without keys) are first-class: they stay
 * {@code identityKeyAlg=LEGACY}, {@code e2eeCapable=false} and are never upgraded in place
 * (E2EE-SPEC D-17/D-S4-03). Arrays are copied defensively; the aggregate never exposes
 * mutable key material.
 */
public final class Device {

    public enum Platform {
        WEB, DESKTOP, MOBILE
    }

    public enum Status {
        PENDING, ACTIVE, REVOKED
    }

    /** Wire/DB values are the E2EE-SPEC §2.5 strings. */
    public enum IdentityKeyAlg {
        LEGACY("LEGACY"),
        ED25519_X25519("Ed25519+X25519");

        private final String wireValue;

        IdentityKeyAlg(String wireValue) {
            this.wireValue = wireValue;
        }

        public String wireValue() {
            return wireValue;
        }

        public static IdentityKeyAlg fromWire(String value) {
            if (value == null) {
                return null;
            }
            for (IdentityKeyAlg alg : values()) {
                if (alg.wireValue.equals(value)) {
                    return alg;
                }
            }
            throw new IllegalArgumentException("Unknown identity_key_alg");
        }
    }

    public static final int MAX_NAME_LENGTH = 80;
    public static final int MAX_APP_VERSION_LENGTH = 40;
    public static final int MAX_KEY_GENERATION = Integer.MAX_VALUE;
    public static final int IDENTITY_KEY_BYTES = 32;
    public static final int BINDING_SIGNATURE_BYTES = 64;

    private final UUID id;
    private final UUID userId;
    private final String name;
    private final Platform platform;
    private final String appVersion;
    private final Status status;
    private final IdentityKeyAlg identityKeyAlg;
    private final byte[] identitySigningKey;
    private final byte[] identityDhKey;
    private final byte[] identityBindingSignature;
    private final byte[] fingerprint;
    private final int keyGeneration;
    private final Instant createdAt;
    private final Instant lastSeenAt;
    private final Instant revokedAt;

    private Device(UUID id, UUID userId, String name, Platform platform, String appVersion,
                   Status status, IdentityKeyAlg identityKeyAlg, byte[] identitySigningKey,
                   byte[] identityDhKey, byte[] identityBindingSignature, byte[] fingerprint,
                   int keyGeneration, Instant createdAt, Instant lastSeenAt, Instant revokedAt) {
        this.id = Objects.requireNonNull(id, "id");
        this.userId = Objects.requireNonNull(userId, "userId");
        this.name = Objects.requireNonNull(name, "name");
        this.platform = Objects.requireNonNull(platform, "platform");
        this.appVersion = Objects.requireNonNull(appVersion, "appVersion");
        this.status = Objects.requireNonNull(status, "status");
        this.identityKeyAlg = Objects.requireNonNull(identityKeyAlg, "identityKeyAlg");
        this.identitySigningKey = copy(identitySigningKey);
        this.identityDhKey = copy(identityDhKey);
        this.identityBindingSignature = copy(identityBindingSignature);
        this.fingerprint = copy(fingerprint);
        if (keyGeneration < 1 || keyGeneration > MAX_KEY_GENERATION) {
            throw new IllegalArgumentException("key_generation must be in 1..2^31-1");
        }
        this.keyGeneration = keyGeneration;
        this.createdAt = createdAt;
        this.lastSeenAt = lastSeenAt;
        this.revokedAt = revokedAt;
        requireKeyInvariant();
    }

    public static Device createWeb(UUID id, UUID userId) {
        return new Device(id, userId, "Dev Web", Platform.WEB, "dev", Status.ACTIVE,
                IdentityKeyAlg.LEGACY, null, null, null, null, 1, null, null, null);
    }

    /** Legacy self-service registration: no E2EE keys, never e2ee_capable (D-S4-03). */
    public static Device registerLegacy(UUID id, UUID userId, String name, String appVersion,
                                       Instant createdAt) {
        return new Device(id, userId, requireText(name, "name", MAX_NAME_LENGTH), Platform.WEB,
                requireText(appVersion, "app_version", MAX_APP_VERSION_LENGTH), Status.ACTIVE,
                IdentityKeyAlg.LEGACY, null, null, null, null, 1,
                Objects.requireNonNull(createdAt, "createdAt"), null, null);
    }

    /** Backwards-compatible alias used by the B-04 provisioning path. */
    public static Device registerWeb(UUID id, UUID userId, String name, String appVersion,
                                     Instant createdAt) {
        return registerLegacy(id, userId, name, appVersion, createdAt);
    }

    public static Device registerWithKeys(UUID id, UUID userId, String name, String appVersion,
                                          byte[] identitySigningKey, byte[] identityDhKey,
                                          byte[] identityBindingSignature, byte[] fingerprint,
                                          Instant createdAt) {
        requireKeyLength(identitySigningKey, IDENTITY_KEY_BYTES, "identity_signing_key");
        requireKeyLength(identityDhKey, IDENTITY_KEY_BYTES, "identity_dh_key");
        requireKeyLength(identityBindingSignature, BINDING_SIGNATURE_BYTES,
                "identity_binding_signature");
        requireKeyLength(fingerprint, IDENTITY_KEY_BYTES, "fingerprint");
        return new Device(id, userId, requireText(name, "name", MAX_NAME_LENGTH), Platform.WEB,
                requireText(appVersion, "app_version", MAX_APP_VERSION_LENGTH), Status.ACTIVE,
                IdentityKeyAlg.ED25519_X25519, identitySigningKey, identityDhKey,
                identityBindingSignature, fingerprint, 1,
                Objects.requireNonNull(createdAt, "createdAt"), null, null);
    }

    public static Device reconstitute(UUID id, UUID userId, String name, Platform platform,
                                      String appVersion, Status status, Instant createdAt) {
        return new Device(id, userId, name, platform, appVersion, status, IdentityKeyAlg.LEGACY,
                null, null, null, null, 1, createdAt, null, null);
    }

    public static Device reconstitute(UUID id, UUID userId, String name, Platform platform,
                                      String appVersion, Status status, IdentityKeyAlg alg,
                                      byte[] identitySigningKey, byte[] identityDhKey,
                                      byte[] identityBindingSignature, byte[] fingerprint,
                                      int keyGeneration, Instant createdAt, Instant lastSeenAt,
                                      Instant revokedAt) {
        return new Device(id, userId, name, platform, appVersion, status, alg,
                identitySigningKey, identityDhKey, identityBindingSignature, fingerprint,
                keyGeneration, createdAt, lastSeenAt, revokedAt);
    }

    /** Revocation is terminal; the generation advances so stale envelopes are rejected. */
    public Device revoke(Instant at) {
        if (status == Status.REVOKED) {
            return this;
        }
        if (keyGeneration >= MAX_KEY_GENERATION) {
            throw new IllegalStateException("key_generation overflow");
        }
        return new Device(id, userId, name, platform, appVersion, Status.REVOKED, identityKeyAlg,
                identitySigningKey, identityDhKey, identityBindingSignature, fingerprint,
                keyGeneration + 1, createdAt, lastSeenAt, Objects.requireNonNull(at, "at"));
    }

    private void requireKeyInvariant() {
        boolean anyKey = identitySigningKey != null || identityDhKey != null
                || identityBindingSignature != null || fingerprint != null;
        if (identityKeyAlg == IdentityKeyAlg.LEGACY) {
            if (anyKey) {
                throw new IllegalArgumentException("LEGACY device must not carry E2EE keys");
            }
            return;
        }
        requireKeyLength(identitySigningKey, IDENTITY_KEY_BYTES, "identity_signing_key");
        requireKeyLength(identityDhKey, IDENTITY_KEY_BYTES, "identity_dh_key");
        requireKeyLength(identityBindingSignature, BINDING_SIGNATURE_BYTES,
                "identity_binding_signature");
        requireKeyLength(fingerprint, IDENTITY_KEY_BYTES, "fingerprint");
    }

    private static void requireKeyLength(byte[] value, int length, String field) {
        if (value == null || value.length != length) {
            throw new IllegalArgumentException(field + " must be " + length + " bytes");
        }
    }

    private static byte[] copy(byte[] value) {
        return value == null ? null : Arrays.copyOf(value, value.length);
    }

    private static String requireText(String value, String field, int maxLength) {
        String normalized = value == null ? null : value.strip();
        if (normalized == null || normalized.isEmpty()) {
            throw new IllegalArgumentException(field + " must not be blank");
        }
        if (normalized.length() > maxLength) {
            throw new IllegalArgumentException(field + " must be at most " + maxLength
                    + " characters");
        }
        return normalized;
    }

    public UUID id() {
        return id;
    }

    public UUID userId() {
        return userId;
    }

    public String name() {
        return name;
    }

    public Platform platform() {
        return platform;
    }

    public String appVersion() {
        return appVersion;
    }

    public Status status() {
        return status;
    }

    public IdentityKeyAlg identityKeyAlg() {
        return identityKeyAlg;
    }

    public byte[] identitySigningKey() {
        return copy(identitySigningKey);
    }

    public byte[] identityDhKey() {
        return copy(identityDhKey);
    }

    public byte[] identityBindingSignature() {
        return copy(identityBindingSignature);
    }

    public byte[] fingerprint() {
        return copy(fingerprint);
    }

    public int keyGeneration() {
        return keyGeneration;
    }

    public Instant createdAt() {
        return createdAt;
    }

    public Instant lastSeenAt() {
        return lastSeenAt;
    }

    public Instant revokedAt() {
        return revokedAt;
    }

    public boolean isActive() {
        return status == Status.ACTIVE;
    }

    /**
     * Derived exactly as E2EE-SPEC §2.5 and the V17 SQL predicate
     * {@code auth.device_is_e2ee_capable(...)}: ACTIVE, Ed25519+X25519 and all four key
     * fields present with exact lengths. The fingerprint is part of the predicate on
     * purpose (P2-05): the SQL/V17 predicate already required it and the domain must not
     * drift when a future migration relaxes a CHECK.
     */
    public boolean isE2eeCapable() {
        return status == Status.ACTIVE
                && identityKeyAlg == IdentityKeyAlg.ED25519_X25519
                && identitySigningKey != null
                && identitySigningKey.length == IDENTITY_KEY_BYTES
                && identityDhKey != null
                && identityDhKey.length == IDENTITY_KEY_BYTES
                && identityBindingSignature != null
                && identityBindingSignature.length == BINDING_SIGNATURE_BYTES
                && fingerprint != null
                && fingerprint.length == IDENTITY_KEY_BYTES;
    }
}
