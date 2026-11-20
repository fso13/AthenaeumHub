package ru.krug.backend.workspace.domain.service;

import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.workspace.domain.model.Membership;

/**
 * Role ceiling for workspace invite links (P0-4 / #82): OWNER is never assignable, OWNER
 * may invite ADMIN/MEMBER/GUEST and ADMIN only MEMBER/GUEST.
 */
public final class WorkspaceInvitePolicy {

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
}
