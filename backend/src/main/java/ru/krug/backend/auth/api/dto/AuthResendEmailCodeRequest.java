package ru.krug.backend.auth.api.dto;

import java.util.UUID;

import jakarta.validation.constraints.NotNull;

/** Request DTO for POST /auth/resend-email-code. */
public record AuthResendEmailCodeRequest(@NotNull UUID verificationId) {
}
