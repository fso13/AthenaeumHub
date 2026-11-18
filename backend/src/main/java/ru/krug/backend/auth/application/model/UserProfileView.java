package ru.krug.backend.auth.application.model;

/**
 * User profile needed by {@code GET /me}. Also the published read model of the auth
 * context for other contexts (sender display name).
 */
public record UserProfileView(String id, String displayName, String email,
                              boolean platformAdmin) {

    public UserProfileView(String id, String displayName, String email) {
        this(id, displayName, email, false);
    }
}
