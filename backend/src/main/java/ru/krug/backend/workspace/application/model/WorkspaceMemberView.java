package ru.krug.backend.workspace.application.model;

import java.time.Instant;
import java.util.UUID;

/** Application view of one active workspace member (contract {@code WorkspaceMember}). */
public record WorkspaceMemberView(
        UUID userId,
        String displayName,
        String role,
        Instant joinedAt) {
}
