package ru.krug.backend.auth.domain.model;

import java.util.Objects;
import java.util.UUID;

/**
 * Link between an external OIDC subject (Keycloak {@code sub}) and a local user.
 * One local user has at most one identity per provider (ENT-02).
 */
public record UserIdentity(UUID id, UUID userId, String provider, String subject) {

    public static final String PROVIDER_KEYCLOAK = "keycloak";

    public UserIdentity {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(userId, "userId");
        provider = require(provider, "provider");
        subject = require(subject, "subject");
    }

    private static String require(String value, String field) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("UserIdentity " + field + " must not be blank");
        }
        return value.strip();
    }
}
