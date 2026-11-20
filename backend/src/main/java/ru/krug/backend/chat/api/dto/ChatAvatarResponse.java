package ru.krug.backend.chat.api.dto;

import java.time.Instant;

/** Presigned channel-avatar download (OpenAPI {@code ProfileAvatar}). */
public record ChatAvatarResponse(String url, Instant expiresAt) {
}
