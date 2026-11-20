package ru.krug.backend.auth.application.usecase;

import java.util.Optional;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import ru.krug.backend.auth.application.command.LoginCommand;
import ru.krug.backend.auth.application.model.AuthSessionView;
import ru.krug.backend.auth.application.model.KeycloakIdentity;
import ru.krug.backend.auth.application.model.KeycloakUserView;
import ru.krug.backend.auth.application.model.LoginOutcome;
import ru.krug.backend.auth.application.model.TokenSet;
import ru.krug.backend.auth.domain.model.TwoFactorSettings;
import ru.krug.backend.auth.application.port.AuthRateLimitPort;
import ru.krug.backend.auth.application.port.InvalidGrantException;
import ru.krug.backend.auth.application.port.KeycloakAdminPort;
import ru.krug.backend.auth.application.port.ProviderUnavailableException;
import ru.krug.backend.auth.application.port.TokenExchangePort;
import ru.krug.backend.auth.application.service.KeycloakIdentityFactory;
import ru.krug.backend.auth.domain.model.EmailVerification;
import ru.krug.backend.auth.domain.model.User;
import ru.krug.backend.auth.domain.repository.EmailVerificationRepository;
import ru.krug.backend.auth.domain.repository.UserRepository;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;

/**
 * {@code POST /auth/login}: Keycloak direct grant for the public {@code krug-web} client.
 * A disabled/unverified Keycloak user is mapped to {@code 403 EMAIL_NOT_VERIFIED} with the
 * still-valid {@code verification_id}; every other rejection is {@code 401}.
 *
 * <p>P0-4: when the local user has an enabled TOTP authenticator, the successful password
 * grant does not produce a session. The token pair is held server-side behind a single-use
 * challenge and {@code POST /auth/2fa/verify} returns the session only after a TOTP or
 * recovery code is accepted.</p>
 */
@Service
public class LoginService {

    private final AuthRateLimitPort rateLimit;
    private final TokenExchangePort tokenExchange;
    private final KeycloakAdminPort keycloak;
    private final EmailVerificationRepository verifications;
    private final UserRepository users;
    private final AuthSessionService sessions;
    private final ClockPort clock;
    private final TwoFactorService twoFactor;
    private final KeycloakIdentityFactory identities;

    @Autowired
    public LoginService(AuthRateLimitPort rateLimit, TokenExchangePort tokenExchange,
                        KeycloakAdminPort keycloak, EmailVerificationRepository verifications,
                        UserRepository users, AuthSessionService sessions, ClockPort clock,
                        TwoFactorService twoFactor, KeycloakIdentityFactory identities) {
        this.rateLimit = rateLimit;
        this.tokenExchange = tokenExchange;
        this.keycloak = keycloak;
        this.verifications = verifications;
        this.users = users;
        this.sessions = sessions;
        this.clock = clock;
        this.twoFactor = twoFactor;
        this.identities = identities;
    }

    /** Back-compat constructor for unit tests that predate P0-4. */
    public LoginService(AuthRateLimitPort rateLimit, TokenExchangePort tokenExchange,
                        KeycloakAdminPort keycloak, EmailVerificationRepository verifications,
                        UserRepository users, AuthSessionService sessions, ClockPort clock) {
        this(rateLimit, tokenExchange, keycloak, verifications, users, sessions, clock, null,
                null);
    }

    public LoginOutcome loginOutcome(LoginCommand command, String clientIp, String requestId) {
        String email = EmailVerification.normalizeEmail(command.email());
        if (email == null || !KeycloakIdentityFactory.isEmail(email)) {
            throw AuthBffErrors.invalidCredentials();
        }
        rateLimit.checkLogin(email, clientIp);

        try {
            TokenSet tokens = tokenExchange.passwordGrant(email, command.password());
            KeycloakIdentity identity = tokenExchange.userInfo(tokens.accessToken());
            if (!identity.emailVerified()) {
                throw AuthBffErrors.emailNotVerified(activeVerificationId(email));
            }
            return complete(identity, tokens, requestId);
        } catch (InvalidGrantException ex) {
            throw mapRejectedGrant(email);
        } catch (ProviderUnavailableException ex) {
            throw AuthBffErrors.authUnavailable("keycloak_unavailable");
        }
    }

    /**
     * Legacy entry point used by unit tests and non-challenge callers. A required second
     * factor is an error here because returning a session would bypass it.
     */
    public AuthSessionView login(LoginCommand command, String clientIp, String requestId) {
        LoginOutcome outcome = loginOutcome(command, clientIp, requestId);
        if (outcome.requiresSecondFactor()) {
            throw new IllegalStateException("Second factor required; use loginOutcome");
        }
        return outcome.session();
    }

    private LoginOutcome complete(KeycloakIdentity identity, TokenSet tokens, String requestId) {
        if (twoFactor == null || identities == null) {
            return LoginOutcome.authenticated(sessions.session(identity, tokens, requestId));
        }
        var localUserId = identities.localUserId(identity.subject());
        return complete(identity, tokens, localUserId, requestId);
    }

    /**
     * Shared second-factor gate for flows that already authenticated the password/email
     * factor. Used by {@link VerifyEmailService} as well, so email verification cannot
     * mint a session while the installation policy requires 2FA (#91).
     */
    public LoginOutcome complete(KeycloakIdentity identity, TokenSet tokens,
                                 java.util.UUID localUserId, String requestId) {
        if (twoFactor == null) {
            return LoginOutcome.authenticated(sessions.session(identity, tokens, requestId));
        }
        Optional<TwoFactorSettings> enabled = twoFactor.findEnabled(localUserId, requestId);
        if (enabled.isPresent()) {
            return LoginOutcome.challenge(twoFactor.challenge(localUserId, identity, tokens));
        }
        if (twoFactor.twoFactorRequired()) {
            return LoginOutcome.challenge(
                    twoFactor.enrollmentChallenge(localUserId, identity, tokens));
        }
        return LoginOutcome.authenticated(sessions.session(identity, tokens, requestId));
    }

    private DomainException mapRejectedGrant(String email) {
        Optional<KeycloakUserView> user;
        try {
            user = keycloak.findByEmail(email);
        } catch (ProviderUnavailableException ex) {
            return AuthBffErrors.authUnavailable("keycloak_unavailable");
        }
        if (user.isPresent() && (!user.get().enabled() || !user.get().emailVerified())) {
            boolean suspended = users.findStatusByEmail(email)
                    .filter(User.Status.SUSPENDED.name()::equals)
                    .isPresent();
            return suspended ? AuthBffErrors.accountSuspended()
                    : AuthBffErrors.emailNotVerified(activeVerificationId(email));
        }
        return AuthBffErrors.invalidCredentials();
    }

    private java.util.UUID activeVerificationId(String email) {
        return verifications.findLatestActiveByEmail(email, clock.now())
                .map(EmailVerification::id)
                .orElse(null);
    }
}
