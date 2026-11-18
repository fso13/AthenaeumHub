package ru.krug.backend.auth.application.usecase;

import java.util.Optional;

import org.springframework.stereotype.Service;

import ru.krug.backend.auth.application.command.LoginCommand;
import ru.krug.backend.auth.application.model.AuthSessionView;
import ru.krug.backend.auth.application.model.KeycloakIdentity;
import ru.krug.backend.auth.application.model.KeycloakUserView;
import ru.krug.backend.auth.application.model.TokenSet;
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

    public LoginService(AuthRateLimitPort rateLimit, TokenExchangePort tokenExchange,
                        KeycloakAdminPort keycloak, EmailVerificationRepository verifications,
                        UserRepository users, AuthSessionService sessions, ClockPort clock) {
        this.rateLimit = rateLimit;
        this.tokenExchange = tokenExchange;
        this.keycloak = keycloak;
        this.verifications = verifications;
        this.users = users;
        this.sessions = sessions;
        this.clock = clock;
    }

    public AuthSessionView login(LoginCommand command, String clientIp, String requestId) {
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
            return sessions.session(identity, tokens, requestId);
        } catch (InvalidGrantException ex) {
            throw mapRejectedGrant(email);
        } catch (ProviderUnavailableException ex) {
            throw AuthBffErrors.authUnavailable("keycloak_unavailable");
        }
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
