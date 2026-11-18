package ru.krug.backend.auth.api.dto;

import java.time.Instant;
import java.util.UUID;

/** Response DTO for POST/GET /devices (OpenAPI {@code Device}). */
public record DeviceResponse(
        UUID id,
        String name,
        String platform,
        String status,
        boolean e2eeCapable,
        int keyGeneration,
        String identitySigningKey,
        String identityDhKey,
        String identityBindingSignature,
        String identityKeyAlg,
        String fingerprint,
        SignedPrekeyResponse signedPrekey,
        int oneTimePrekeysAvailable,
        Instant createdAt,
        Instant lastSeenAt) {
}
