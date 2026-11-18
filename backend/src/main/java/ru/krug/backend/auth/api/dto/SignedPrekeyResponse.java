package ru.krug.backend.auth.api.dto;

import java.time.Instant;

public record SignedPrekeyResponse(String keyId, String publicKey, String signature,
                                   Instant createdAt, Instant expiresAt) {
}
