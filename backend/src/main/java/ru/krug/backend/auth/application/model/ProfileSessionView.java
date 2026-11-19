package ru.krug.backend.auth.application.model;

import java.time.Instant;

/**
 * One row of {@code GET /me/sessions}. {@code current} is true when the Keycloak
 * {@code sid} claim of the calling access token identifies this session; it is false when
 * the token has no sid (for example a dev token).
 */
public record ProfileSessionView(
        String id,
        String name,
        Instant createdAt,
        Instant lastAccessAt,
        boolean current) {
}
