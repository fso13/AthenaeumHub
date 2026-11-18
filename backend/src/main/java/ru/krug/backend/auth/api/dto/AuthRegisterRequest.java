package ru.krug.backend.auth.api.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** Request DTO for POST /auth/register (OpenAPI {@code AuthRegisterRequest}). */
public record AuthRegisterRequest(
        @NotBlank @Email @Size(max = 254) String email,
        @NotBlank @Size(max = 80) String displayName,
        @NotBlank @Size(min = 10, max = 128) String password) {
}
