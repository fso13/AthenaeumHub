package ru.krug.backend.auth.application.model;

import java.util.UUID;

/** Local (JIT-provisioned) user attached to an AuthSession. */
public record AuthUserView(UUID id, String displayName, String email, boolean platformAdmin) {

    public AuthUserView(UUID id, String displayName, String email) {
        this(id, displayName, email, false);
    }
}
