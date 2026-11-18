package ru.krug.backend.auth.api.dto;

import java.util.UUID;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;

/** Request DTO for POST /auth/verify-email. */
public record AuthVerifyEmailRequest(
        @NotNull UUID verificationId,
        @NotBlank @Pattern(regexp = "[0-9]{6}") String code) {
}
