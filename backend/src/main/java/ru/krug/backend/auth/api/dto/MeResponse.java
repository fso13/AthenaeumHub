package ru.krug.backend.auth.api.dto;

import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonProperty;

/** Response DTO for GET /me (OpenAPI {@code MeResponse}). */
public record MeResponse(User user, List<Workspace> workspaces, UUID defaultWorkspaceId) {

    public record User(UUID id, String displayName, String email,
                       @JsonProperty("is_platform_admin") boolean platformAdmin) {

        public User(UUID id, String displayName, String email) {
            this(id, displayName, email, false);
        }
    }

    public record Workspace(UUID id, String name, String slug, String role, String securityMode) {
    }
}
