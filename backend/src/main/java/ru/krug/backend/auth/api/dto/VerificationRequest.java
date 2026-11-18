package ru.krug.backend.auth.api.dto;

import java.util.UUID;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;

public record VerificationRequest(
        @NotNull UUID deviceId,
        String method,
        Integer vhVersion,
        String safetyNumberHash,
        @Min(1) Integer expectedKeyGeneration) {
}
