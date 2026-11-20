package ru.krug.backend.auth.infrastructure.keycloak;

import java.net.URI;

import org.springframework.stereotype.Component;

import ru.krug.backend.auth.infrastructure.config.AuthBffProperties;
import ru.krug.backend.shared.infrastructure.config.KrugProperties;

/**
 * Internal Keycloak URLs. The base URL is either configured explicitly or derived from
 * {@code krug.oidc.issuer} (compose already points it at {@code http://keycloak:8080}),
 * so the BFF never needs to publish Keycloak to the browser.
 */
@Component
public class KeycloakEndpoints {

    private static final String FALLBACK_BASE = "http://localhost:8180";

    private final String baseUrl;
    private final String realm;
    private final String adminRealm;

    public KeycloakEndpoints(AuthBffProperties properties, KrugProperties krug) {
        this.baseUrl = resolveBase(properties.keycloak().baseUrl(), krug.oidc().issuer());
        this.realm = properties.keycloak().realm();
        this.adminRealm = properties.keycloak().adminRealm();
    }

    public String baseUrl() {
        return baseUrl;
    }

    public String realm() {
        return realm;
    }

    public String adminTokenUrl() {
        return baseUrl + "/realms/" + adminRealm + "/protocol/openid-connect/token";
    }

    public String tokenUrl() {
        return baseUrl + "/realms/" + realm + "/protocol/openid-connect/token";
    }

    public String userInfoUrl() {
        return baseUrl + "/realms/" + realm + "/protocol/openid-connect/userinfo";
    }

    public String logoutUrl() {
        return baseUrl + "/realms/" + realm + "/protocol/openid-connect/logout";
    }

    public String adminUsersUrl() {
        return baseUrl + "/admin/realms/" + realm + "/users";
    }

    public String adminUserUrl(String userId) {
        return adminUsersUrl() + "/" + userId;
    }

    /** Invalidate every active session of a user (Keycloak Admin API). */
    public String adminUserLogoutUrl(String userId) {
        return adminUserUrl(userId) + "/logout";
    }

    /** List the user's active sessions (Keycloak Admin API). */
    public String adminUserSessionsUrl(String userId) {
        return adminUserUrl(userId) + "/sessions";
    }

    /** Revoke one session of the user (Keycloak Admin API). */
    public String adminUserSessionUrl(String userId, String sessionId) {
        return adminUserSessionsUrl(userId) + "/" + sessionId;
    }

    /** Revoke one session by id without the owner (Keycloak 26 realm-level endpoint). */
    public String adminSessionUrl(String sessionId) {
        return baseUrl + "/admin/realms/" + realm + "/sessions/" + sessionId;
    }

    private static String resolveBase(String configured, String issuer) {
        String candidate = configured == null ? "" : configured.strip();
        if (candidate.isEmpty() && issuer != null && !issuer.isBlank()) {
            try {
                URI uri = URI.create(issuer.strip());
                if (uri.getScheme() != null && uri.getRawAuthority() != null) {
                    candidate = uri.getScheme() + "://" + uri.getRawAuthority();
                }
            } catch (IllegalArgumentException ignored) {
                // Fall through to the dev default.
            }
        }
        if (candidate.isEmpty()) {
            candidate = FALLBACK_BASE;
        }
        while (candidate.endsWith("/")) {
            candidate = candidate.substring(0, candidate.length() - 1);
        }
        return candidate;
    }
}
