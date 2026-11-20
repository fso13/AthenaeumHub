package ru.krug.backend.auth.application.model;

import java.time.Instant;
import java.util.UUID;

/** One blocked user (#79); no email or display name. */
public record BlockedUserView(UUID userId, Instant blockedAt) {
}
