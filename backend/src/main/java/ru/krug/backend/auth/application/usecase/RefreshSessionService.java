package ru.krug.backend.auth.application.usecase;

import java.util.UUID;

import org.springframework.stereotype.Service;

import ru.krug.backend.auth.application.model.AuthSessionView;
import ru.krug.backend.auth.application.model.KeycloakIdentity;
import ru.krug.backend.auth.application.model.TokenSet;
import ru.krug.backend.auth.application.port.AccessTokenSessionPort;
import ru.krug.backend.auth.application.port.InvalidGrantException;
import ru.krug.backend.auth.application.port.ProviderUnavailableException;
import ru.krug.backend.auth.application.port.SecondFactorSessionPort;
import ru.krug.backend.auth.application.port.TokenExchangePort;
import ru.krug.backend.auth.application.service.KeycloakIdentityFactory;

/**
 * {@code POST /auth/refresh}: Keycloak rotates the access/refresh pair.
 *
 * <p>#91: when the account needs a second factor (installation policy on or a confirmed
 * authenticator), only a refresh token minted by a challenge-completed session may be
 * rotated. A password-only session can therefore not outlive its access token; the caller
 * must complete the TOTP/ENROLL challenge and receives 403 {@code TWO_FACTOR_REQUIRED}.</p>
 */
@Service
public class RefreshSessionService {

    private final TokenExchangePort tokenExchange;
    private final AuthSessionService sessions;
    private final TwoFactorService twoFactor;
    private final KeycloakIdentityFactory identities;
    private final SecondFactorSessionPort completedSessions;
    private final AccessTokenSessionPort accessTokenSessions;
    private final SessionTimeoutGuard sessionTimeout;

    public RefreshSessionService(TokenExchangePort tokenExchange, AuthSessionService sessions,
                                 TwoFactorService twoFactor, KeycloakIdentityFactory identities,
                                 SecondFactorSessionPort completedSessions,
                                 AccessTokenSessionPort accessTokenSessions,
                                 SessionTimeoutGuard sessionTimeout) {
        this.tokenExchange = tokenExchange;
        this.sessions = sessions;
        this.twoFactor = twoFactor;
        this.identities = identities;
        this.completedSessions = completedSessions;
        this.accessTokenSessions = accessTokenSessions;
        this.sessionTimeout = sessionTimeout;
    }

    public AuthSessionView refresh(String refreshToken, String requestId) {
        try {
            TokenSet tokens = tokenExchange.refresh(refreshToken);
            KeycloakIdentity identity = tokenExchange.userInfo(tokens.accessToken());
            if (!identity.emailVerified()) {
                throw AuthBffErrors.emailNotVerified(null);
            }
            UUID localUserId = identities.localUserId(identity.subject());
            boolean requiresSecondFactor =
                    twoFactor.requiresSecondFactor(localUserId, requestId);
            if (requiresSecondFactor && !completedSessions.isVerified(refreshToken)) {
                // The Keycloak token was already rotated above; the browser must sign in
                // again and complete the second factor. Never echo either token.
                throw AuthBffErrors.twoFactorRequired();
            }
            // #101: refresh is the only path that can extend a stateless BFF session.
            // The idle clock is based on real API activity (not refresh), so an abandoned
            // auto-refreshing tab is rejected here and the new refresh token is revoked.
            String sessionId = accessTokenSessions.sessionId(tokens.accessToken()).orElse(null);
            if (sessionTimeout.isExpired(localUserId, sessionId)) {
                revokeQuietly(tokens.refreshToken());
                throw AuthBffErrors.sessionExpired();
            }
            AuthSessionView session = sessions.session(identity, tokens, requestId);
            if (requiresSecondFactor) {
                completedSessions.markVerified(session.refreshToken());
            }
            return session;
        } catch (InvalidGrantException ex) {
            throw AuthBffErrors.invalidCredentials();
        } catch (ProviderUnavailableException ex) {
            throw AuthBffErrors.authUnavailable("keycloak_unavailable");
        }
    }

    private void revokeQuietly(String refreshToken) {
        try {
            tokenExchange.revoke(refreshToken);
        } catch (RuntimeException ignored) {
            // The session must be rejected even if the IdP revocation call fails; the
            // refresh token is never logged.
        }
    }
}
