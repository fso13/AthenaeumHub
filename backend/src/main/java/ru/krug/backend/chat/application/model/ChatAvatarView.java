package ru.krug.backend.chat.application.model;

import java.time.Instant;

/** Presigned channel-avatar download (OpenAPI {@code ProfileAvatar}). */
public record ChatAvatarView(String url, Instant expiresAt) {
}
