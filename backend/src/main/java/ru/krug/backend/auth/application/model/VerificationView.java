package ru.krug.backend.auth.application.model;

import java.time.Instant;
import java.util.UUID;

public record VerificationView(UUID chatId, UUID verifierDeviceId, UUID deviceId,
                               int keyGeneration, boolean verified, Instant verifiedAt,
                               String method) {
}
