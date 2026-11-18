package ru.krug.backend.workspace.application.service;

import java.util.LinkedHashMap;
import java.util.Map;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.workspace.domain.model.WorkspaceMemberMutation;

/**
 * Translates the SECURITY DEFINER outcome strings into domain exceptions. Keeping one
 * mapping means add/role/remove expose the same status/code for the same condition.
 */
public final class WorkspaceMemberErrors {

    private WorkspaceMemberErrors() {
    }

    public static void throwIfFailed(WorkspaceMemberMutation result) {
        switch (result.outcome()) {
            case OK -> {
                // Caller continues with the returned member.
            }
            case FORBIDDEN -> throw DomainException.forbidden(
                    "No rights to manage workspace members");
            case ROLE_FORBIDDEN -> throw DomainException.forbidden(ErrorCode.ROLE_CHANGE_FORBIDDEN,
                    "This role change is not allowed", Map.of("role", role(result)));
            case ROLE_INVALID -> throw DomainException.badRequest(
                    "role is invalid", Map.of("field", "role"));
            case USER_NOT_FOUND -> throw DomainException.notFound(ErrorCode.USER_NOT_FOUND,
                    "User not found", Map.of("field", "email"));
            case MEMBER_NOT_FOUND -> throw DomainException.notFound(ErrorCode.MEMBER_NOT_FOUND,
                    "Workspace member not found", Map.of("field", "user_id"));
            case ALREADY_EXISTS -> throw DomainException.conflict(
                    ErrorCode.MEMBER_ALREADY_EXISTS,
                    "User is already a member of this workspace",
                    Map.of("field", "email"));
            case LIMIT_REACHED -> throw limitReached(result);
            case SELF -> throw DomainException.conflict(ErrorCode.SELF_ACTION_FORBIDDEN,
                    "A member cannot change or remove their own membership",
                    Map.of("field", "user_id"));
            case LAST_OWNER -> throw DomainException.conflict(ErrorCode.LAST_OWNER,
                    "The last workspace owner cannot be demoted or removed",
                    Map.of("field", "user_id"));
        }
    }

    private static DomainException limitReached(WorkspaceMemberMutation result) {
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("scope", "WORKSPACE");
        details.put("limit", result.membersLimit());
        details.put("used", result.membersUsed());
        return DomainException.conflict(ErrorCode.WORKSPACE_MEMBER_LIMIT_REACHED,
                "Workspace member limit reached", details);
    }

    private static String role(WorkspaceMemberMutation result) {
        return result.role() == null ? "" : result.role().name();
    }
}
