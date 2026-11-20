package ru.krug.backend.auth.api.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;

/** {@code POST /me/2fa/verify}: six-digit TOTP code. */
public record TwoFactorVerifyRequest(
        @NotBlank @Pattern(regexp = "[0-9]{6}") String code) {
}
