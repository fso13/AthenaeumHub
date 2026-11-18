package ru.krug.backend.shared.application.model;

import java.time.Instant;

public record IssuedToken(String accessToken, Instant expiresAt) {
}
