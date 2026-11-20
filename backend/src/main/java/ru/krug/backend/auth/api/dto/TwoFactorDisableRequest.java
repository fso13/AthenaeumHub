package ru.krug.backend.auth.api.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** {@code DELETE /me/2fa}: password plus a TOTP or one-time recovery code. */
public record TwoFactorDisableRequest(
        @NotBlank @Size(max = 128) String password,
        @NotBlank @Size(max = 20) String code) {
}
