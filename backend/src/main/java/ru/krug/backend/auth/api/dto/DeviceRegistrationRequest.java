package ru.krug.backend.auth.api.dto;

import java.util.List;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * OpenAPI {@code DeviceRegistration}. Key fields are optional in the schema but
 * all-or-none in semantics (§6.3.1 D-S4-03).
 */
public record DeviceRegistrationRequest(
        @NotBlank @Size(max = 80) String name,
        @NotBlank @Pattern(regexp = "WEB", message = "must be WEB") String platform,
        @NotBlank @Size(max = 40) String appVersion,
        String identitySigningKey,
        String identityDhKey,
        String identityBindingSignature,
        String identityKeyAlg,
        SignedPrekeyRequest signedPrekey,
        List<OneTimePrekeyRequest> oneTimePrekeys) {
}
