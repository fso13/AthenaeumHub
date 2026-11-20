package ru.krug.backend.auth.api.dto;

import java.time.Instant;

/** Presigned avatar download (OpenAPI {@code ProfileAvatar}). */
public record ProfileAvatarResponse(String url, Instant expiresAt) {
}
