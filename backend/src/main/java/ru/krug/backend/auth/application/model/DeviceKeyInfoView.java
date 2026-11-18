package ru.krug.backend.auth.application.model;

import java.time.Instant;
import java.util.UUID;

public record DeviceKeyInfoView(UUID deviceId, UUID userId, String platform, String status,
                                String identitySigningKey, String identityDhKey,
                                String identityBindingSignature, String identityKeyAlg,
                                String fingerprint, int keyGeneration, String signedPrekeyId,
                                boolean self, Boolean verified, Instant verifiedAt,
                                String verificationMethod, Instant lastSeenAt) {
}
