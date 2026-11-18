package ru.krug.backend.workspace.api.dto;

import java.time.Instant;
import java.util.UUID;

/** Response DTO for one workspace member (contract {@code WorkspaceMember}). */
public record WorkspaceMemberResponse(
        UUID userId,
        String displayName,
        String role,
        Instant joinedAt) {
}
