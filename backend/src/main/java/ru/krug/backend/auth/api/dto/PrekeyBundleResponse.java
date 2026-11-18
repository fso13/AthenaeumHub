package ru.krug.backend.auth.api.dto;

import java.util.UUID;

public record PrekeyBundleResponse(
        UUID userId,
        UUID deviceId,
        int keyGeneration,
        String identitySigningKey,
        String identityDhKey,
        String identityBindingSignature,
        String identityKeyAlg,
        SignedPrekeyResponse signedPrekey,
        OneTimePrekeyRequest oneTimePrekey,
        boolean otpExhausted) {
}
