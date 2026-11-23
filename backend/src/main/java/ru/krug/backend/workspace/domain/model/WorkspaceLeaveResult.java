package ru.krug.backend.workspace.domain.model;

import java.util.Objects;

/**
 * Result of {@code workspace.leave_workspace} (#99). The SQL function returns an outcome
 * instead of raising, so the application maps it to a transport-neutral
 * {@link ru.krug.backend.shared.error.DomainException}. {@code role} is the role the caller
 * had at leave time (also set on LAST_OWNER for diagnostics); it never contains user data.
 */
public record WorkspaceLeaveResult(Outcome outcome, Membership.Role role,
                                   int chatMembershipsRemoved) {

    public enum Outcome {
        OK,
        ALREADY_LEFT,
        FORBIDDEN,
        LAST_OWNER
    }

    public WorkspaceLeaveResult {
        Objects.requireNonNull(outcome, "outcome");
    }
}
