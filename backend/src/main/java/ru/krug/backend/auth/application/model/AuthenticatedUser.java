package ru.krug.backend.auth.application.model;

import java.util.UUID;

/** Local user resolved (and, on first login, provisioned) from an OIDC subject. */
public record AuthenticatedUser(UUID userId, String displayName, String email,
                                boolean platformAdmin) {

    /** Back-compat constructor for callers that do not need the admin flag. */
    public AuthenticatedUser(UUID userId, String displayName, String email) {
        this(userId, displayName, email, false);
    }
}
