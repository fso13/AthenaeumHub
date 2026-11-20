package ru.krug.backend.workspace.api.dto;

import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonProperty;

public record WorkspaceInviteAcceptanceResponse(
        @JsonProperty("workspace_id") UUID workspaceId,
        String name,
        String slug,
        String role,
        @JsonProperty("already_member") boolean alreadyMember) {
}
