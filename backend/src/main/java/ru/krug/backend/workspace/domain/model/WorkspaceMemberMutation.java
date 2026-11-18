package ru.krug.backend.workspace.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * Outcome of one workspace membership mutation. The SECURITY DEFINER function returns an
 * outcome instead of raising, so the application maps it to a transport-neutral
 * {@link ru.krug.backend.shared.error.DomainException} without parsing SQLSTATE.
 *
 * <p>The record is also the success payload: {@code userId}, {@code displayName},
 * {@code role} and {@code joinedAt} feed {@code WorkspaceMember}; {@code previousRole}
 * feeds the audit event. {@code membersUsed}/{@code membersLimit} are set on
 * {@code LIMIT_REACHED} so the 409 carries {@code details.limit/used}.</p>
 */
public record WorkspaceMemberMutation(
        Outcome outcome,
        UUID userId,
        String displayName,
        Membership.Role role,
        Membership.Role previousRole,
        Instant joinedAt,
        int membersUsed,
        int membersLimit) {

    public enum Outcome {
        OK,
        FORBIDDEN,
        ROLE_FORBIDDEN,
        ROLE_INVALID,
        USER_NOT_FOUND,
        MEMBER_NOT_FOUND,
        ALREADY_EXISTS,
        LIMIT_REACHED,
        SELF,
        LAST_OWNER
    }

    public WorkspaceMemberMutation {
        Objects.requireNonNull(outcome, "outcome");
    }

    public static WorkspaceMemberMutation success(UUID userId, String displayName,
                                                  Membership.Role role,
                                                  Membership.Role previousRole,
                                                  Instant joinedAt) {
        return new WorkspaceMemberMutation(Outcome.OK, userId, displayName, role,
                previousRole, joinedAt, 0, 0);
    }

    public static WorkspaceMemberMutation limitReached(int used, int limit) {
        return new WorkspaceMemberMutation(Outcome.LIMIT_REACHED, null, null, null, null,
                null, used, limit);
    }
}
