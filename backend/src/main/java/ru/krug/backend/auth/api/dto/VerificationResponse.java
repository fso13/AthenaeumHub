package ru.krug.backend.auth.api.dto;

import java.time.Instant;
import java.util.UUID;

public record VerificationResponse(UUID chatId, UUID verifierDeviceId, UUID deviceId,
                                   int keyGeneration, boolean verified, Instant verifiedAt,
                                   String method) {
}
