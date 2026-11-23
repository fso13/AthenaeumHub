package ru.krug.backend.workspace.domain.model;

import java.time.Instant;

/**
 * #100 anonymous preview of an invite token. It intentionally carries display metadata
 * only: the invited address, token hash and raw token never leave the database.
 */
public record WorkspaceInvitePreview(Status status, String workspaceName, String workspaceSlug,
                                     String role, boolean emailBound, Instant expiresAt) {

    public enum Status {
        OK, NOT_FOUND, WORKSPACE_UNAVAILABLE, REVOKED, EXPIRED, EXHAUSTED;

        public static Status parse(String value) {
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

    public static WorkspaceInvitePreview notFound() {
        return new WorkspaceInvitePreview(Status.NOT_FOUND, null, null, null, false, null);
    }
}
