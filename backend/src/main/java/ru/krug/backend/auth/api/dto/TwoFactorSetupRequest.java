package ru.krug.backend.auth.api.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** {@code POST /me/2fa/setup}: password re-authentication is required. */
public record TwoFactorSetupRequest(@NotBlank @Size(max = 128) String password) {
}
