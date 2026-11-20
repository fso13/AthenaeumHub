package ru.krug.backend.auth.api.dto;

import java.time.Instant;
import java.util.UUID;

/** OpenAPI {@code BlockedUser} (#79): id and timestamp only. */
public record BlockedUserResponse(UUID userId, Instant blockedAt) {
}
