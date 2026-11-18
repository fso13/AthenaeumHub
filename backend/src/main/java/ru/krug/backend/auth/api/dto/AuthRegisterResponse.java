package ru.krug.backend.auth.api.dto;

import java.util.UUID;

/** Response DTO for POST /auth/register (OpenAPI {@code AuthRegisterResponse}). */
public record AuthRegisterResponse(UUID verificationId, long expiresIn, long resendAfter) {
}
