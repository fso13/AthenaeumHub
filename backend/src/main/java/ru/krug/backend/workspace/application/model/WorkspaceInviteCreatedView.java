package ru.krug.backend.workspace.application.model;

/**
 * Create response: metadata plus the raw token/accept URL returned exactly once. Neither
 * value is persisted, logged or audited in plaintext. For an email-bound invite (#100) the
 * same token is also delivered to the recipient by the SMTP adapter.
 */
public record WorkspaceInviteCreatedView(WorkspaceInviteView invite, String token,
                                         String acceptUrl) {

    @Override
    public String toString() {
        return "WorkspaceInviteCreatedView[invite=" + invite + ", token=redacted]";
    }
}
