package ru.krug.backend.workspace.application.service;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.workspace.domain.model.Membership;

/** Transport-independent normalisation of the member-management request fields. */
public final class WorkspaceMemberRequests {

    private WorkspaceMemberRequests() {
    }

    public static String email(String email) {
        if (email == null || email.isBlank()) {
            throw DomainException.badRequest("email must not be blank",
                    Map.of("field", "email"));
        }
        String normalized = email.strip();
        if (normalized.length() > 254) {
            throw DomainException.badRequest("email must be at most 254 characters",
                    Map.of("field", "email", "max_length", 254));
        }
        return normalized;
    }

    /**
     * Parses a role literal. OWNER is accepted here so the SECURITY DEFINER function can
     * answer {@code 403 ROLE_CHANGE_FORBIDDEN} (the owner is immutable, never assignable);
     * an unknown literal is a {@code 400 VALIDATION_FAILED}.
     */
    public static Membership.Role role(String role) {
        if (role == null || role.isBlank()) {
            throw DomainException.badRequest("role is required", Map.of("field", "role"));
        }
        try {
            return Membership.Role.valueOf(role.strip());
        } catch (IllegalArgumentException ex) {
            throw DomainException.badRequest(
                    "role must be OWNER, ADMIN, MEMBER or GUEST",
                    Map.of("field", "role", "allowed", "OWNER,ADMIN,MEMBER,GUEST"));
        }
    }
}
