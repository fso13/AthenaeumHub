package ru.krug.backend.workspace.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * One workspace DLP rule (P0-3). The pattern is a bounded literal value; the application
 * never compiles it as a regular expression. {@code name} is unique per workspace
 * (case-insensitive).
 */
public record DlpPolicy(
        UUID id,
        UUID workspaceId,
        String name,
        DlpAction action,
        DlpPatternType patternType,
        String pattern,
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
        Objects.requireNonNull(createdBy, "createdBy");
        Objects.requireNonNull(createdAt, "createdAt");
        Objects.requireNonNull(updatedAt, "updatedAt");
    }

    public DlpPolicy withDetails(String newName, DlpAction newAction,
                                 DlpPatternType newPatternType, String newPattern,
                                 boolean newEnabled, Instant now) {
        return new DlpPolicy(id, workspaceId, newName, newAction, newPatternType, newPattern,
                newEnabled, createdBy, createdAt, now);
    }
}
