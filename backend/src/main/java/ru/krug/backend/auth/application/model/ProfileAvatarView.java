package ru.krug.backend.auth.application.model;

import java.time.Instant;

/** Short-lived presigned avatar download returned by {@code GET /me/avatar}. */
public record ProfileAvatarView(String url, Instant expiresAt) {
}
