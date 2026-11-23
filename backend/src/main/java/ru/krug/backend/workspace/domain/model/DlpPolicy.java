package ru.krug.backend.workspace.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * One workspace DLP rule (P0-3 / #101). The pattern is a bounded literal value; the
 * application never compiles it as a regular expression. {@code name} is unique per
 * workspace (case-insensitive).
 *
 * <p>{@code scope} selects the managed surface (message/edit text, attachment metadata or
 * plugin payload). {@code maxFileSizeBytes} is an attachment-only threshold: when set, a
 * file larger than the limit matches the rule even if the text pattern does not. Both are
 * policy configuration, never content — no file name, message text or payload is stored
 * on the rule or in the decision log.</p>
 */
public record DlpPolicy(
        UUID id,
        UUID workspaceId,
        String name,
        DlpAction action,
        DlpPatternType patternType,
        String pattern,
        DlpScope scope,
        Long maxFileSizeBytes,
        boolean enabled,
        UUID createdBy,
        Instant createdAt,
        Instant updatedAt) {

    public DlpPolicy {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(workspaceId, "workspaceId");
        Objects.requireNonNull(name, "name");
        Objects.requireNonNull(action, "action");
        Objects.requireNonNull(patternType, "patternType");
        Objects.requireNonNull(pattern, "pattern");
        scope = scope == null ? DlpScope.ALL : scope;
        if (maxFileSizeBytes != null && maxFileSizeBytes < 1) {
            throw new IllegalArgumentException("maxFileSizeBytes must be positive");
        }
        Objects.requireNonNull(createdBy, "createdBy");
        Objects.requireNonNull(createdAt, "createdAt");
        Objects.requireNonNull(updatedAt, "updatedAt");
    }

    public DlpPolicy withDetails(String newName, DlpAction newAction,
                                 DlpPatternType newPatternType, String newPattern,
                                 DlpScope newScope, Long newMaxFileSizeBytes,
                                 boolean newEnabled, Instant now) {
        return new DlpPolicy(id, workspaceId, newName, newAction, newPatternType, newPattern,
                newScope, newMaxFileSizeBytes, newEnabled, createdBy, createdAt, now);
    }
}
