package ru.krug.backend.workspace.domain.model;

import java.util.UUID;

/** Result of the {@code workspace.accept_invite} SQL function. */
public record WorkspaceInviteAcceptance(Outcome outcome, UUID inviteId, UUID workspaceId,
                                        String role, boolean alreadyMember) {

    public enum Outcome {
        OK, NOT_FOUND, FORBIDDEN, WORKSPACE_UNAVAILABLE, REVOKED, EXPIRED, EXHAUSTED,
        /** #100: the invite is bound to another email address; it is not consumed. */
        EMAIL_MISMATCH;

        public static Outcome parse(String value) {
            if (value == null) {
                return NOT_FOUND;
            }
            try {
                return valueOf(value);
            } catch (IllegalArgumentException ex) {
                return NOT_FOUND;
            }
        }
    }

    public static WorkspaceInviteAcceptance failed(Outcome outcome) {
        return new WorkspaceInviteAcceptance(outcome, null, null, null, false);
    }
}
