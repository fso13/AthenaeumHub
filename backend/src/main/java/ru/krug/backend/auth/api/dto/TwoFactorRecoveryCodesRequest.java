package ru.krug.backend.auth.api.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** {@code POST /me/2fa/recovery-codes}: regenerate the one-time list. */
public record TwoFactorRecoveryCodesRequest(@NotBlank @Size(max = 128) String password) {
}
