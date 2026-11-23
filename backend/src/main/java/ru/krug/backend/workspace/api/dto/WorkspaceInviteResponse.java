package ru.krug.backend.workspace.api.dto;

import java.time.Instant;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonProperty;

/** Invite metadata (never the token/hash). */
public record WorkspaceInviteResponse(
        UUID id,
        String role,
        String status,
        @JsonProperty("used_count") int usedCount,
        @JsonProperty("max_uses") Integer maxUses,
        @JsonProperty("expires_at") Instant expiresAt,
        @JsonProperty("created_at") Instant createdAt,
        @JsonProperty("created_by") UUID createdBy,
        // #100: normalized recipient of a single-use email invite; null for a link invite.
        String email) {
}
