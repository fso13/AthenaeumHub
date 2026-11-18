package ru.krug.backend.auth.application.model;

import java.util.UUID;

public record PrekeyBundleView(UUID userId, UUID deviceId, int keyGeneration,
                               String identitySigningKey, String identityDhKey,
                               String identityBindingSignature, String identityKeyAlg,
                               SignedPrekeyView signedPrekey, OneTimePrekeyView oneTimePrekey,
                               boolean otpExhausted) {
}
