package ru.krug.backend.workspace.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * One workspace-scoped audit row. Deliberately excludes {@code metadata}, hash-chain
 * bytes, request id and actor email: the workspace audit contract exposes action, actor,
 * target and time only, so content and secrets can never leak through this view.
 */
public record WorkspaceAuditEvent(
        UUID id,
        String action,
        UUID actorId,
        String targetType,
        UUID targetId,
        Instant createdAt) {

    public WorkspaceAuditEvent {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(action, "action");
        Objects.requireNonNull(createdAt, "createdAt");
    }
}
