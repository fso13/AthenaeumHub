package ru.krug.backend.auth.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

/** {@code AuthSession.user}. */
public record AuthUserResponse(java.util.UUID id, String displayName, String email,
                               @JsonProperty("is_platform_admin") boolean platformAdmin) {

    public AuthUserResponse(java.util.UUID id, String displayName, String email) {
        this(id, displayName, email, false);
    }
}
