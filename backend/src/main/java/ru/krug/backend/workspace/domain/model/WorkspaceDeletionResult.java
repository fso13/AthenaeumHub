package ru.krug.backend.workspace.domain.model;

import java.util.Objects;

/**
 * Result of {@code workspace.delete_workspace} (#99). The counters feed the audit event only
 * (they contain no content); {@code ALREADY_DELETED} is the idempotent replay for the OWNER.
 */
public record WorkspaceDeletionResult(Outcome outcome, int membershipsRemoved,
                                      int invitesRevoked, int chatMembershipsRemoved,
                                      int botsDisabled) {

    public enum Outcome {
        OK,
        ALREADY_DELETED,
        FORBIDDEN,
        NOT_OWNER
    }

    public WorkspaceDeletionResult {
        Objects.requireNonNull(outcome, "outcome");
    }
}
