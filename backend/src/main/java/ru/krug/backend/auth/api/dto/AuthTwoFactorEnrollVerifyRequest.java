package ru.krug.backend.auth.api.dto;

import java.util.UUID;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;

/** {@code POST /auth/2fa/enroll/verify}: six-digit code for the pending secret. */
public record AuthTwoFactorEnrollVerifyRequest(
        @NotNull UUID challengeId,
        @NotBlank @Pattern(regexp = "[0-9]{6}") String code) {
}
