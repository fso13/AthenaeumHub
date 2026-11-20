package ru.krug.backend.auth.application.model;

/**
 * User profile needed by {@code GET /me}. Also the published read model of the auth
 * context for other contexts (sender display name).
 *
 * <p>{@code avatarUrl} is a stable relative URL served by {@code GET /me/avatar} and is
 * {@code null} when no avatar is set. It never contains a raw storage key or token.</p>
 */
public record UserProfileView(String id, String displayName, String email,
                              boolean platformAdmin, String bio, String phone,
                              String avatarUrl) {

    public UserProfileView(String id, String displayName, String email) {
        this(id, displayName, email, false, null, null, null);
    }

    public UserProfileView(String id, String displayName, String email,
                           boolean platformAdmin) {
        this(id, displayName, email, platformAdmin, null, null, null);
    }

    public UserProfileView(String id, String displayName, String email, boolean platformAdmin,
                           String bio, String phone) {
        this(id, displayName, email, platformAdmin, bio, phone, null);
    }
}
