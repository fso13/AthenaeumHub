package ru.krug.backend.auth.domain.model;

import java.time.Instant;
import java.util.Arrays;
import java.util.Objects;
import java.util.UUID;

/**
 * One public prekey row ({@code auth.device_prekeys}). Signed prekeys carry an Ed25519
 * signature; one-time prekeys do not. Private keys never leave the client.
 */
public record DevicePrekey(
        UUID deviceId,
        String keyId,
        Kind kind,
        byte[] publicKey,
        byte[] signature,
        Instant createdAt,
        Instant expiresAt,
        Instant retiredAt,
        Instant consumedAt) {

    public enum Kind {
        SIGNED, ONE_TIME
    }

    public static final int PUBLIC_KEY_BYTES = 32;
    public static final int SIGNATURE_BYTES = 64;
    public static final int MAX_KEY_ID_LENGTH = 64;

    public DevicePrekey {
        Objects.requireNonNull(deviceId, "deviceId");
        Objects.requireNonNull(keyId, "keyId");
        Objects.requireNonNull(kind, "kind");
        publicKey = copy(publicKey);
        signature = copy(signature);
        Objects.requireNonNull(publicKey, "publicKey");
        Objects.requireNonNull(expiresAt, "expiresAt");
        if (publicKey.length != PUBLIC_KEY_BYTES) {
            throw new IllegalArgumentException("public_key must be 32 bytes");
        }
        if (kind == Kind.SIGNED
                && (signature == null || signature.length != SIGNATURE_BYTES)) {
            throw new IllegalArgumentException("signed prekey requires a 64-byte signature");
        }
        if (kind == Kind.ONE_TIME && signature != null) {
            throw new IllegalArgumentException("one-time prekey must not carry a signature");
        }
        if (keyId.isBlank() || keyId.length() > MAX_KEY_ID_LENGTH) {
            throw new IllegalArgumentException("key_id must be 1..64 characters");
        }
    }

    public static DevicePrekey signed(UUID deviceId, String keyId, byte[] publicKey,
                                      byte[] signature, Instant now, Instant expiresAt) {
        return new DevicePrekey(deviceId, keyId, Kind.SIGNED, publicKey, signature, now,
                expiresAt, null, null);
    }

    public static DevicePrekey oneTime(UUID deviceId, String keyId, byte[] publicKey,
                                       Instant now, Instant expiresAt) {
        return new DevicePrekey(deviceId, keyId, Kind.ONE_TIME, publicKey, null, now, expiresAt,
                null, null);
    }

    public boolean isAvailable(Instant now) {
        return consumedAt == null && retiredAt == null && expiresAt.isAfter(now);
    }

    @Override
    public byte[] publicKey() {
        return copy(publicKey);
    }

    @Override
    public byte[] signature() {
        return copy(signature);
    }

    private static byte[] copy(byte[] value) {
        return value == null ? null : Arrays.copyOf(value, value.length);
    }
}
