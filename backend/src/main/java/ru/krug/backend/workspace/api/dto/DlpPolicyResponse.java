package ru.krug.backend.workspace.api.dto;

import java.time.Instant;
import java.util.UUID;

/** Response DTO for one DLP rule (contract {@code DlpPolicy}). */
public record DlpPolicyResponse(
        UUID id,
        String name,
        String action,
        String patternType,
        String pattern,
        String scope,
        Long maxFileSizeBytes,
        boolean enabled,
        Instant createdAt,
        Instant updatedAt) {
}
