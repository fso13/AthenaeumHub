package ru.krug.backend.workspace.application.model;

import java.time.Instant;
import java.util.UUID;

/**
 * One DLP rule exposed to a workspace OWNER/ADMIN. The pattern is bounded config, not
 * content. {@code scope} and {@code maxFileSizeBytes} are the #101 enforcement surface and
 * the attachment-only size threshold.
 */
public record DlpPolicyView(
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
