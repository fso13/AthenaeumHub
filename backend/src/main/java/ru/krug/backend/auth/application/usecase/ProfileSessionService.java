package ru.krug.backend.auth.application.usecase;

import java.util.Comparator;
import java.util.List;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.auth.application.model.KeycloakSessionView;
import ru.krug.backend.auth.application.model.ProfileSessionView;
import ru.krug.backend.auth.application.port.KeycloakAdminPort;
import ru.krug.backend.auth.application.port.ProviderUnavailableException;
import ru.krug.backend.auth.domain.model.UserIdentity;
import ru.krug.backend.auth.domain.repository.UserIdentityRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;

/**
 * {@code GET /me/sessions} and {@code DELETE /me/sessions/{sessionId}}.
 *
 * <p>Keycloak sessions are addressed by the caller's own OIDC subject, resolved from the
 * local identity link. The URL never carries a user id, so a caller cannot enumerate or
 * revoke another user's sessions: the ownership check compares the requested session id
 * with the session list Keycloak returns for the caller's subject. A foreign or already
 * removed id is {@code 404}, never a side effect.</p>
 *
 * <p>The Keycloak admin payload's IP address and username are dropped by the adapter;
 * only a client-name label and timestamps reach this service.</p>
 */
@Service
public class ProfileSessionService {

    private final TenantContext tenantContext;
    private final UserIdentityRepository identities;
    private final KeycloakAdminPort keycloak;

    public ProfileSessionService(TenantContext tenantContext, UserIdentityRepository identities,
                                 KeycloakAdminPort keycloak) {
        this.tenantContext = tenantContext;
        this.identities = identities;
        this.keycloak = keycloak;
    }

    @Transactional(readOnly = true)
    public List<ProfileSessionView> list(Principal principal) {
        UUID keycloakUserId = keycloakUserId(principal);
        List<KeycloakSessionView> sessions = listFromKeycloak(keycloakUserId);
        String currentSessionId = principal.sessionId();
        return sessions.stream()
                .map(session -> new ProfileSessionView(session.id(),
                        session.name(), session.createdAt(), session.lastAccessAt(),
                        currentSessionId != null && currentSessionId.equals(session.id())))
                .sorted(Comparator.comparing(ProfileSessionView::lastAccessAt).reversed())
                .toList();
    }

    @Transactional(readOnly = true)
    public void revoke(Principal principal, String sessionId) {
        if (sessionId == null || sessionId.isBlank()) {
            throw DomainException.badRequest("sessionId must not be blank",
                    java.util.Map.of("field", "sessionId"));
        }
        UUID keycloakUserId = keycloakUserId(principal);
        List<KeycloakSessionView> sessions = listFromKeycloak(keycloakUserId);
        boolean owned = sessions.stream().anyMatch(session -> sessionId.equals(session.id()));
        if (!owned) {
            // Foreign and already-revoked ids are deliberately indistinguishable.
            throw DomainException.notFound("Session not found");
        }
        try {
            keycloak.revokeSession(keycloakUserId, sessionId);
        } catch (ProviderUnavailableException ex) {
            throw AuthBffErrors.authUnavailable("keycloak_unavailable");
        }
    }

    private List<KeycloakSessionView> listFromKeycloak(UUID keycloakUserId) {
        try {
            return keycloak.listSessions(keycloakUserId);
        } catch (ProviderUnavailableException ex) {
            throw AuthBffErrors.authUnavailable("keycloak_unavailable");
        }
    }

    /**
     * Resolves the caller's Keycloak subject through the local identity link. A user
     * without a Keycloak link (dev profile) cannot have Keycloak sessions: this is a
     * provider-unavailable response rather than an empty list, so clients do not show a
     * misleading "no sessions" state.
     */
    private UUID keycloakUserId(Principal principal) {
        tenantContext.activate(principal.withWorkspace(null));
        String subject = identities.findByUserIdAndProvider(principal.userId(),
                        UserIdentity.PROVIDER_KEYCLOAK)
                .map(UserIdentity::subject)
                .orElseThrow(() -> AuthBffErrors.authUnavailable("keycloak_identity_missing"));
        UUID keycloakUserId = parseUuid(subject);
        if (keycloakUserId == null) {
            throw AuthBffErrors.authUnavailable("keycloak_identity_invalid");
        }
        return keycloakUserId;
    }

    private static UUID parseUuid(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value.strip());
        } catch (IllegalArgumentException ex) {
            return null;
        }
    }
}
