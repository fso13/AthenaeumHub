package ru.krug.backend.auth.application.port;

import java.util.UUID;

import ru.krug.backend.auth.application.model.UserProfileView;

/**
 * Read port used by other contexts instead of joining auth tables across module
 * boundaries.
 */
public interface UserProfilePort {

    String displayName(UUID userId);

    UserProfileView requireProfile(UUID userId);

    /**
     * Server-side platform-admin check. Implementations must read the persisted flag, never
     * a client claim or token attribute (FR-ADM-8).
     */
    default boolean isPlatformAdmin(UUID userId) {
        return requireProfile(userId).platformAdmin();
    }
}
