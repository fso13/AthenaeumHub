package ru.krug.backend.workspace.application.model;

import java.time.Instant;
import java.util.UUID;

/**
 * One workspace audit row for the OWNER/ADMIN view. No metadata, hash-chain bytes,
 * request id or actor email: those never leave the database through this view.
 */
public record WorkspaceAuditView(
        UUID id,
        String action,
        UUID actorId,
        String targetType,
        UUID targetId,
        Instant createdAt) {
}
