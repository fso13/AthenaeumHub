package ru.krug.backend.auth.api.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** Request DTO for POST /auth/refresh. */
public record AuthRefreshRequest(
        @NotBlank @Size(max = 4096) String refreshToken) {
}
