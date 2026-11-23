package ru.krug.backend.ops.application.model;

import java.util.UUID;

/** One workspace with a retention policy, read by the daily job (#101). */
public record RetentionTarget(UUID workspaceId, int retentionDays) {

    public RetentionTarget {
        if (workspaceId == null) {
            throw new IllegalArgumentException("workspaceId is required");
        }
        if (retentionDays < 1) {
            throw new IllegalArgumentException("retentionDays must be positive");
        }
    }
}
