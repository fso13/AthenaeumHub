package ru.krug.backend.auth.api.dto;

import java.time.Instant;
import java.util.UUID;

public record DeviceKeyInfoResponse(
        UUID deviceId,
        UUID userId,
        String platform,
        String status,
        String identitySigningKey,
        String identityDhKey,
        String identityBindingSignature,
        String identityKeyAlg,
        String fingerprint,
        int keyGeneration,
        String signedPrekeyId,
        boolean isSelf,
        Boolean verified,
        Instant verifiedAt,
        String verificationMethod,
        Instant lastSeenAt) {
}
