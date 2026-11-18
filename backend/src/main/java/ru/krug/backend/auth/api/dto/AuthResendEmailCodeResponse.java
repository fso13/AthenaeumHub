package ru.krug.backend.auth.api.dto;

/** Response DTO for POST /auth/resend-email-code. */
public record AuthResendEmailCodeResponse(long expiresIn, long resendAfter) {
}
