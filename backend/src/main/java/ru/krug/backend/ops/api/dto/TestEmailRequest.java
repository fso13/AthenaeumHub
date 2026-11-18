package ru.krug.backend.ops.api.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** Request DTO for POST /admin/settings/test-email. */
public record TestEmailRequest(
        @NotBlank @Email @Size(max = 254) String to) {
}
