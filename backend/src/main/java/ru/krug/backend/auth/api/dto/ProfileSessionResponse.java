package ru.krug.backend.auth.api.dto;

import java.time.Instant;

/** One active Keycloak session of the caller (no IP address, username or token). */
public record ProfileSessionResponse(
        String id,
        String name,
        Instant createdAt,
        Instant lastAccessAt,
        boolean current) {
}
