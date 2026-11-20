package ru.krug.backend.workspace.application.model;

import java.time.Instant;
import java.util.UUID;

/** Invite metadata; never contains the token or its hash. */
public record WorkspaceInviteView(UUID id, String role, String status, int usedCount,
                                  Integer maxUses, Instant expiresAt, Instant createdAt,
                                  UUID createdBy) {
}
