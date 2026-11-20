package ru.krug.backend.ops.domain.repository;

import java.util.Optional;
import java.util.UUID;

/**
 * Maps a local user id to the opaque Keycloak subject used to address the Admin sessions
 * API. The V49 SQL function re-checks the platform-admin caller; email, username, IP and
 * tokens are never returned.
 */
public interface AdminSessionDirectory {

    Optional<String> findKeycloakSubject(UUID userId, UUID callerId);
}
