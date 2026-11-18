package ru.krug.backend.auth.application.model;

import java.time.Instant;

public record SignedPrekeyView(String keyId, String publicKey, String signature,
                               Instant createdAt, Instant expiresAt) {
}
