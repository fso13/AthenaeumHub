package ru.krug.backend.workspace.domain.service;

import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.workspace.domain.model.Membership;

/**
 * Role ceiling and email validation for workspace invite links (P0-4 / #82, #100): OWNER is
 * never assignable, OWNER may invite ADMIN/MEMBER/GUEST and ADMIN only MEMBER/GUEST.
 */
public final class WorkspaceInvitePolicy {

    /** Pragmatic RFC 5322 subset: one @, no whitespace, a dot in the domain, <= 254 chars. */
    private static final Pattern EMAIL =
            Pattern.compile("^[^@\\s]{1,64}@[^@\\s.]+(?:\\.[^@\\s.]+)+$");

    private WorkspaceInvitePolicy() {
    }

    public static Membership.Role requireInvitableRole(String value) {
        Membership.Role role;
        try {
            role = Membership.Role.valueOf(value == null ? "" : value.strip());
        } catch (IllegalArgumentException ex) {
            throw DomainException.badRequest("Unknown workspace role",
                    Map.of("field", "role"));
        }
        if (role == Membership.Role.OWNER) {
            throw DomainException.forbidden(ErrorCode.WORKSPACE_INVITE_ROLE_FORBIDDEN,
                    "OWNER cannot be granted through an invite link", Map.of("field", "role"));
        }
        return role;
    }

    public static void requireCanInvite(Membership.Role actor, Membership.Role target) {
        if (target == Membership.Role.OWNER) {
            throw DomainException.forbidden(ErrorCode.WORKSPACE_INVITE_ROLE_FORBIDDEN,
                    "OWNER cannot be granted through an invite link", Map.of("field", "role"));
        }
        if (actor == Membership.Role.OWNER) {
            return;
        }
        if (actor == Membership.Role.ADMIN && target != Membership.Role.ADMIN) {
            return;
        }
        throw DomainException.forbidden(ErrorCode.WORKSPACE_INVITE_ROLE_FORBIDDEN,
                "This role cannot be granted by the caller", Map.of("field", "role"));
    }

    /**
     * #100: an optional email is normalized to lower case before it is stored, compared and
     * mailed. Blank means "link invite" (null); anything else must look like an address.
     */
    public static String normalizeEmail(String value) {
        if (value == null) {
            return null;
        }
        String normalized = value.strip().toLowerCase(Locale.ROOT);
        if (normalized.isEmpty()) {
            return null;
        }
        if (normalized.length() > 254 || !EMAIL.matcher(normalized).matches()) {
            throw DomainException.badRequest("email is invalid", Map.of("field", "email"));
        }
        return normalized;
    }
}
