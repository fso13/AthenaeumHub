package ru.krug.backend.chat.domain.service;

import java.util.Map;
import java.util.Set;
import java.util.UUID;

import ru.krug.backend.chat.domain.model.ChatMember;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Membership rules for GROUP channels (#79): role literals, the OWNER/ADMIN ceiling, self
 * actions and the "last owner" invariant. Pure domain logic so both the HTTP use cases and
 * the unit tests use exactly one implementation.
 */
public final class ChatMemberPolicy {

    public static final String DEFAULT_ROLE = "MEMBER";

    private static final Set<String> INVITE_ROLES =
            Set.of("ADMIN", "MODERATOR", "MEMBER", "GUEST");

    private ChatMemberPolicy() {
    }

    /** PATCH role literal (OWNER is assignable by an OWNER). */
    public static ChatMember.Role requireRole(String value) {
        if (value == null || value.isBlank()) {
            throw DomainException.badRequest("role is required",
                    Map.of("field", "role"));
        }
        try {
            return ChatMember.Role.valueOf(value);
        } catch (IllegalArgumentException ex) {
            throw DomainException.badRequest("role is invalid",
                    Map.of("field", "role", "allowed", "OWNER,ADMIN,MODERATOR,MEMBER,GUEST"));
        }
    }

    /** POST add role; absent means MEMBER. */
    public static ChatMember.Role requireAddRole(String value) {
        return value == null || value.isBlank()
                ? ChatMember.Role.MEMBER
                : requireRole(value);
    }

    /** Invite link role; absent means MEMBER and OWNER is rejected outright. */
    public static ChatMember.Role requireInviteRole(String value) {
        String literal = value == null || value.isBlank() ? DEFAULT_ROLE : value;
        if (!INVITE_ROLES.contains(literal)) {
            throw DomainException.badRequest(
                    "role must be ADMIN, MODERATOR, MEMBER or GUEST for an invite link",
                    Map.of("field", "role", "allowed", "ADMIN,MODERATOR,MEMBER,GUEST"));
        }
        return ChatMember.Role.valueOf(literal);
    }

    public static boolean canManage(String actorRole) {
        return "OWNER".equals(actorRole) || "ADMIN".equals(actorRole);
    }

    public static void requireManager(String actorRole) {
        if (!canManage(actorRole)) {
            throw DomainException.forbidden(
                    "Only an active chat OWNER or ADMIN can manage channel members");
        }
    }

    /** ADMIN cannot touch OWNER/ADMIN rows; OWNER may manage everyone. */
    public static void requireCanManageTarget(String actorRole, ChatMember.Role targetRole) {
        if ("ADMIN".equals(actorRole)
                && (targetRole == ChatMember.Role.OWNER
                    || targetRole == ChatMember.Role.ADMIN)) {
            throw DomainException.forbidden(ErrorCode.ROLE_CHANGE_FORBIDDEN,
                    "An ADMIN cannot manage OWNER or ADMIN channel members",
                    Map.of("target_role", targetRole.name()));
        }
    }

    /**
     * P0-2 invite/add ceiling: OWNER may assign any role, ADMIN cannot assign OWNER/ADMIN,
     * and a lower role (MODERATOR/MEMBER/GUEST) that was granted {@code invite_members} can
     * assign only MEMBER/GUEST.
     */
    public static void requireCanAssignInviteRole(String actorRole, ChatMember.Role target) {
        if ("OWNER".equals(actorRole)) {
            return;
        }
        if ("ADMIN".equals(actorRole)) {
            if (target == ChatMember.Role.OWNER || target == ChatMember.Role.ADMIN) {
                throw DomainException.forbidden(ErrorCode.ROLE_CHANGE_FORBIDDEN,
                        "An ADMIN cannot assign OWNER or ADMIN",
                        Map.of("role", target.name()));
            }
            return;
        }
        if (target != ChatMember.Role.MEMBER && target != ChatMember.Role.GUEST) {
            throw DomainException.forbidden(ErrorCode.ROLE_CHANGE_FORBIDDEN,
                    "Only an OWNER or ADMIN can assign this role",
                    Map.of("role", target.name(), "actor_role", actorRole));
        }
    }

    /** ADMIN cannot assign OWNER/ADMIN; OWNER may assign any role. */
    public static void requireCanAssign(String actorRole, ChatMember.Role role) {
        if ("ADMIN".equals(actorRole)
                && (role == ChatMember.Role.OWNER || role == ChatMember.Role.ADMIN)) {
            throw DomainException.forbidden(ErrorCode.ROLE_CHANGE_FORBIDDEN,
                    "An ADMIN cannot assign OWNER or ADMIN",
                    Map.of("role", role.name()));
        }
    }

    public static void requireNotSelf(UUID actorId, UUID targetId) {
        if (actorId.equals(targetId)) {
            throw DomainException.conflict(ErrorCode.SELF_ACTION_FORBIDDEN,
                    "A member cannot change their own channel role",
                    Map.of("field", "user_id"));
        }
    }

    /**
     * The last ACTIVE OWNER can never be demoted or removed. Callers must hold the chat
     * membership advisory lock and pass the owner count observed under that lock.
     */
    public static void requireOwnerPreserved(ChatMember.Role targetRole,
                                             ChatMember.Role newRole,
                                             long activeOwners) {
        if (targetRole == ChatMember.Role.OWNER && newRole != ChatMember.Role.OWNER
                && activeOwners <= 1) {
            throw lastOwner();
        }
    }

    public static void requireOwnerPreservedOnRemoval(ChatMember.Role targetRole,
                                                      long activeOwners) {
        if (targetRole == ChatMember.Role.OWNER && activeOwners <= 1) {
            throw lastOwner();
        }
    }

    public static boolean isActiveMember(ChatMember member) {
        return member != null && member.isActive();
    }

    private static DomainException lastOwner() {
        return DomainException.conflict(ErrorCode.LAST_OWNER,
                "The last channel owner cannot be demoted or removed",
                Map.of("field", "role"));
    }
}
