package ru.krug.backend.auth.api.dto;

import java.util.UUID;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/** {@code POST /auth/2fa/verify}: complete the login challenge with TOTP/recovery code. */
public record AuthTwoFactorVerifyRequest(@NotNull UUID challengeId,
                                         @NotBlank @Size(max = 20) String code) {
}
