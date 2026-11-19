package ru.krug.backend.auth.application.port;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.auth.application.model.KeycloakSessionView;
import ru.krug.backend.auth.application.model.KeycloakUserView;

/**
 * Keycloak Admin REST API port (admin-cli token, internal URL only). Implementations must
 * never log credentials, request bodies or user emails.
 */
public interface KeycloakAdminPort {

    Optional<KeycloakUserView> findByEmail(String email);

    Optional<KeycloakUserView> findById(UUID userId);

    /**
     * Creates a disabled, unverified Keycloak user with {@code username=email} and
     * {@code firstName=displayName}.
     *
     * @throws UserAlreadyExistsException when Keycloak reports a duplicate username/email
     */
    UUID createUser(String email, String displayName);

    /**
     * @throws PasswordRejectedException when the identity provider rejects the password
     */
    void setPassword(UUID userId, String password);

    void updateEnabledAndVerified(UUID userId, boolean enabled, boolean emailVerified);

    /**
     * Enables/disables a Keycloak user without touching {@code emailVerified} (E11-B
     * suspend/activate). A missing Keycloak user is a provider error.
     */
    void setEnabled(UUID userId, boolean enabled);

    /**
     * Invalidates every active Keycloak session of the user ({@code POST .../logout}), so
     * refresh tokens stop working and the browser must re-authenticate. Idempotent: a user
     * without sessions is not an error.
     */
    void logoutAllSessions(UUID userId);

    /**
     * Best-effort profile display-name sync. Sets {@code firstName}/{@code lastName} to
     * the same value, matching {@link #createUser(String, String)}. A missing Keycloak user
     * is treated as a no-op.
     */
    void updateDisplayName(UUID userId, String displayName);

    /**
     * Active sessions of the user. Only id, a client-derived label and timestamps cross the
     * port: IP addresses and usernames are intentionally not exposed.
     *
     * @throws ProviderUnavailableException on transport/5xx failures
     */
    List<KeycloakSessionView> listSessions(UUID userId);

    /**
     * Revoke one session. A session that is already gone is not an error.
     *
     * @throws ProviderUnavailableException on transport/5xx failures
     */
    void revokeSession(UUID userId, String sessionId);

    /** Best-effort delete used for rollback/cleanup; a missing user is not an error. */
    void deleteUser(UUID userId);
}
