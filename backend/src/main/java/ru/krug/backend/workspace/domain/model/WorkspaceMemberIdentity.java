package ru.krug.backend.workspace.domain.model;

import java.util.Objects;
import java.util.UUID;

/**
 * Identity link of an ACTIVE workspace member, reduced to the local user id and the
 * opaque Keycloak subject. Used only to address the Keycloak Admin session API; no email,
 * display name, device or token data crosses this boundary.
 */
public record WorkspaceMemberIdentity(UUID userId, String keycloakSubject) {

    public WorkspaceMemberIdentity {
        Objects.requireNonNull(userId, "userId");
        Objects.requireNonNull(keycloakSubject, "keycloakSubject");
    }
}
