package ru.krug.backend.workspace.infrastructure.invite;

import java.util.UUID;

import org.springframework.stereotype.Component;

import ru.krug.backend.auth.application.port.RegistrationInviteClaimPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.workspace.application.usecase.WorkspaceInviteService;

/**
 * Connects the auth post-verification hook to the workspace invite use case. The request id
 * is forwarded for audit only; the raw token never leaves the auth flow (only its digest is
 * stored and passed here).
 */
@Component
public class RegistrationInviteClaimAdapter implements RegistrationInviteClaimPort {

    private final WorkspaceInviteService invites;

    public RegistrationInviteClaimAdapter(WorkspaceInviteService invites) {
        this.invites = invites;
    }

    @Override
    public void claim(UUID userId, String inviteTokenHash, String requestId) {
        if (userId == null) {
            return;
        }
        invites.claimAfterVerification(new Principal(userId, null, null, requestId),
                inviteTokenHash);
    }
}
