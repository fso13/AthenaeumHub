package ru.krug.backend.workspace.domain.model;

import java.time.Instant;
import java.util.UUID;

/**
 * One row of the active workspace member directory. Contains only the contract fields:
 * no email, credentials, devices or keys ever leave the database for this read.
 */
public record WorkspaceMemberRow(
        UUID userId,
        String displayName,
        String role,
        Instant joinedAt) {
}
