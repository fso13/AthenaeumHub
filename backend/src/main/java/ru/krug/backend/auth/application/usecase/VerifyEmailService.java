package ru.krug.backend.auth.application.usecase;

import java.util.Optional;

import org.springframework.stereotype.Service;

import ru.krug.backend.auth.application.command.VerifyEmailCommand;
import ru.krug.backend.auth.application.model.AuthSessionView;
import ru.krug.backend.auth.application.model.KeycloakIdentity;
import ru.krug.backend.auth.application.model.TokenSet;
import ru.krug.backend.auth.application.port.InvalidGrantException;
import ru.krug.backend.auth.application.port.KeycloakAdminPort;
import ru.krug.backend.auth.application.port.PendingSessionPort;
import ru.krug.backend.auth.application.port.ProviderUnavailableException;
import ru.krug.backend.auth.application.port.TokenExchangePort;
import ru.krug.backend.auth.domain.model.EmailVerification;

/**
 * {@code POST /auth/verify-email}: validate the TOTP, enable + verify the Keycloak user,
 * consume the pending row, then exchange the server-side refresh token for a session.
 */
@Service
public class VerifyEmailService {

    private final VerifyEmailTx verificationTx;
    private final KeycloakAdminPort keycloak;
    private final TokenExchangePort tokenExchange;
    private final PendingSessionPort pendingSessions;
    private final AuthSessionService sessions;

    public VerifyEmailService(VerifyEmailTx verificationTx, KeycloakAdminPort keycloak,
                              TokenExchangePort tokenExchange,
                              PendingSessionPort pendingSessions, AuthSessionService sessions) {
        this.verificationTx = verificationTx;
        this.keycloak = keycloak;
        this.tokenExchange = tokenExchange;
        this.pendingSessions = pendingSessions;
        this.sessions = sessions;
    }

    public AuthSessionView verify(VerifyEmailCommand command, String requestId) {
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
        return sessions.session(identity, tokens, requestId);
    }
}
