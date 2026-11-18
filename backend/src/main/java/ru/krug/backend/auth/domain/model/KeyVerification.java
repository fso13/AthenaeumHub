package ru.krug.backend.auth.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * Attestation that a concrete verifier DEVICE compared safety numbers with a concrete
 * target device in a chat. The server stores only the 32-byte hash, never the digits.
 */
public record KeyVerification(
        UUID id,
        UUID workspaceId,
        UUID chatId,
        UUID verifierUserId,
        UUID verifierDeviceId,
        UUID targetDeviceId,
        int targetKeyGeneration,
        Method method,
        int vhVersion,
        byte[] safetyNumberHash,
        Instant verifiedAt,
        Instant revokedAt) {

    public enum Method {
        QR, MANUAL
    }

    public static final int VH_VERSION = 2;
    public static final int HASH_BYTES = 32;

    public KeyVerification {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(workspaceId, "workspaceId");
        Objects.requireNonNull(chatId, "chatId");
        Objects.requireNonNull(verifierUserId, "verifierUserId");
        Objects.requireNonNull(verifierDeviceId, "verifierDeviceId");
        Objects.requireNonNull(targetDeviceId, "targetDeviceId");
        Objects.requireNonNull(method, "method");
        Objects.requireNonNull(verifiedAt, "verifiedAt");
        if (targetKeyGeneration < 1) {
            throw new IllegalArgumentException("target_key_generation must be > 0");
        }
        if (vhVersion != VH_VERSION) {
            throw new IllegalArgumentException("vh_version must be 2");
        }
        if (safetyNumberHash == null || safetyNumberHash.length != HASH_BYTES) {
            throw new IllegalArgumentException("safety_number_hash must be 32 bytes");
        }
        safetyNumberHash = safetyNumberHash.clone();
    }

    @Override
    public byte[] safetyNumberHash() {
        return safetyNumberHash.clone();
    }
}
