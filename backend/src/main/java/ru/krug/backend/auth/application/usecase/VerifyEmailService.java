package ru.krug.backend.auth.application.usecase;

import java.util.Optional;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import ru.krug.backend.auth.application.command.VerifyEmailCommand;
import ru.krug.backend.auth.application.model.KeycloakIdentity;
import ru.krug.backend.auth.application.model.LoginOutcome;
import ru.krug.backend.auth.application.model.TokenSet;
import ru.krug.backend.auth.application.port.InvalidGrantException;
import ru.krug.backend.auth.application.port.JitProvisioningPort;
import ru.krug.backend.auth.application.port.KeycloakAdminPort;
import ru.krug.backend.auth.application.port.PendingSessionPort;
import ru.krug.backend.auth.application.port.ProviderUnavailableException;
import ru.krug.backend.auth.application.port.RegistrationInviteClaimPort;
import ru.krug.backend.auth.application.port.TokenExchangePort;
import ru.krug.backend.auth.application.service.KeycloakIdentityFactory;
import ru.krug.backend.auth.domain.model.EmailVerification;

/**
 * {@code POST /auth/verify-email}: validate the TOTP, enable + verify the Keycloak user,
 * consume the pending row, then exchange the server-side refresh token for a session.
 *
 * <p>#100: when registration carried an {@code invite_token}, the local user is provisioned
 * first and the invite is claimed after verification. The claim is best-effort and
 * idempotent: an expired/revoked/foreign invite is left untouched and still returns the
 * normal session, so account existence/enumeration is never disclosed.</p>
 */
@Service
public class VerifyEmailService {

    private static final Logger log = LoggerFactory.getLogger(VerifyEmailService.class);

    private final VerifyEmailTx verificationTx;
    private final KeycloakAdminPort keycloak;
    private final TokenExchangePort tokenExchange;
    private final PendingSessionPort pendingSessions;
    private final LoginService loginGate;
    private final KeycloakIdentityFactory identities;
    private final JitProvisioningPort jitProvisioning;
    private final RegistrationInviteClaimPort inviteClaims;

    public VerifyEmailService(VerifyEmailTx verificationTx, KeycloakAdminPort keycloak,
                              TokenExchangePort tokenExchange,
                              PendingSessionPort pendingSessions,
                              LoginService loginGate,
                              KeycloakIdentityFactory identities,
                              JitProvisioningPort jitProvisioning,
                              RegistrationInviteClaimPort inviteClaims) {
        this.verificationTx = verificationTx;
        this.keycloak = keycloak;
        this.tokenExchange = tokenExchange;
        this.pendingSessions = pendingSessions;
        this.loginGate = loginGate;
        this.identities = identities;
        this.jitProvisioning = jitProvisioning;
        this.inviteClaims = inviteClaims;
    }

    /**
     * Verifies the email code and then applies the same second-factor gate as
     * {@code /auth/login} (#91): with the installation policy on, the response is a
     * {@code 202} ENROLL/TOTP challenge and no session, never a direct session.
     */
    public LoginOutcome verify(VerifyEmailCommand command, String requestId) {
        EmailVerification verification = verificationTx.attempt(command.verificationId(),
                command.code());

        try {
            keycloak.updateEnabledAndVerified(verification.keycloakUserId(), true, true);
        } catch (ProviderUnavailableException ex) {
            throw AuthBffErrors.authUnavailable("keycloak_unavailable");
        }

        if (!verificationTx.complete(verification.id())) {
            throw AuthBffErrors.codeExpired();
        }

        Optional<String> refreshToken = pendingSessions.consume(verification.id());
        if (refreshToken.isEmpty()) {
            // The account is verified but the short-lived bridge was lost (restart/multi-node).
            // The user can sign in with the password they just set.
            throw AuthBffErrors.authUnavailable("sign_in_required");
        }

        TokenSet tokens;
        try {
            tokens = tokenExchange.refresh(refreshToken.get());
        } catch (InvalidGrantException ex) {
            throw AuthBffErrors.authUnavailable("sign_in_required");
        } catch (ProviderUnavailableException ex) {
            throw AuthBffErrors.authUnavailable("keycloak_unavailable");
        }

        KeycloakIdentity identity = new KeycloakIdentity(
                verification.keycloakUserId().toString(), verification.email(), true,
                verification.email(), verification.displayName());
        UUID localUserId = identities.localUserId(identity.subject());
        boolean hasInvite = verification.inviteTokenHash() != null;
        if (hasInvite) {
            // The claim runs on the local auth.users row; provision it before the 2FA gate
            // so even an enrollment challenge leaves a valid membership behind.
            localUserId = jitProvisioning.ensure(identity, requestId).userId();
        }
        LoginOutcome outcome = loginGate.complete(identity, tokens, localUserId, requestId);
        if (hasInvite) {
            claimInvite(verification, localUserId, requestId);
        }
        return outcome;
    }

    private void claimInvite(EmailVerification verification, UUID localUserId,
                             String requestId) {
        try {
            inviteClaims.claim(localUserId, verification.inviteTokenHash(), requestId);
        } catch (RuntimeException ex) {
            // The account is already verified; a failed/expired claim must not turn the
            // verification into an error. Log ids only - never the token or its hash.
            log.warn("Workspace invite claim skipped verification_id={} user_id={}",
                    verification.id(), localUserId);
        }
    }
}
