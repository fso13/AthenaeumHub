package ru.krug.backend.auth.application.model;

import java.util.UUID;

/**
 * Stable self-service avatar location (P0-4 / #82). The URL stays the same when the
 * avatar is replaced; {@code GET /me/avatar} redirects to a short-lived presigned object
 * URL. The raw attachment id and storage key never appear in the profile payload.
 */
public final class ProfileAvatars {

    public static final String SELF_URL = "/api/v1/me/avatar";

    private ProfileAvatars() {
    }

    public static String url(UUID avatarFileId) {
        return avatarFileId == null ? null : SELF_URL;
    }
}
