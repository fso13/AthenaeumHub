package ru.krug.backend.auth.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** Request DTO for POST /auth/register (OpenAPI {@code AuthRegisterRequest}). */
public record AuthRegisterRequest(
        @NotBlank @Email @Size(max = 254) String email,
        @NotBlank @Size(max = 80) String displayName,
        @NotBlank @Size(min = 10, max = 128) String password,
        // #100: optional single-use workspace invite token; the backend stores only its
        // SHA-256 digest and claims the invite after the email code is verified.
        @JsonProperty("invite_token") @Size(max = 128) String inviteToken) {
}
