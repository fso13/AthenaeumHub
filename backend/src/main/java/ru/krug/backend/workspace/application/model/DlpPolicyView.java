package ru.krug.backend.workspace.application.model;

import java.time.Instant;
import java.util.UUID;

/** One DLP rule exposed to a workspace OWNER/ADMIN. The pattern is bounded config, not content. */
public record DlpPolicyView(
        UUID id,
        String name,
        String action,
        String patternType,
        String pattern,
        boolean enabled,
        Instant createdAt,
        Instant updatedAt) {
}
