package ru.krug.backend.auth.api.dto;

import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonProperty;

/** Response DTO for GET /me (OpenAPI {@code MeResponse}). */
public record MeResponse(User user, List<Workspace> workspaces, UUID defaultWorkspaceId) {

    public record User(UUID id, String displayName, String email,
                       @JsonProperty("is_platform_admin") boolean platformAdmin,
                       String bio, String phone, @JsonProperty("avatar_url") String avatarUrl) {

        public User(UUID id, String displayName, String email) {
            this(id, displayName, email, false, null, null, null);
        }

        public User(UUID id, String displayName, String email, boolean platformAdmin) {
            this(id, displayName, email, platformAdmin, null, null, null);
        }

        public User(UUID id, String displayName, String email, boolean platformAdmin,
                    String bio, String phone) {
            this(id, displayName, email, platformAdmin, bio, phone, null);
        }
    }

    public record Workspace(UUID id, String name, String slug, String role, String securityMode,
                            String description,
                            @JsonProperty("logo_file_id") UUID logoFileId) {

        public Workspace(UUID id, String name, String slug, String role, String securityMode) {
            this(id, name, slug, role, securityMode, null, null);
        }
    }
}
