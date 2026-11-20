package ru.krug.backend.auth.application.usecase;

import java.util.Optional;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import ru.krug.backend.auth.application.model.KeycloakIdentity;
import ru.krug.backend.auth.application.model.TokenSet;
import ru.krug.backend.auth.application.port.InvalidGrantException;
import ru.krug.backend.auth.application.port.ProviderUnavailableException;
import ru.krug.backend.auth.application.port.TokenExchangePort;
import ru.krug.backend.auth.domain.model.UserIdentity;
import ru.krug.backend.auth.domain.repository.UserIdentityRepository;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Password re-authentication for sensitive self-service operations (P0-4 / #82).
 *
 * <p>The password is verified against Keycloak with the normal password grant and the
 * resulting subject is compared with the caller's own {@code auth.user_identities} link,
 * so a valid password for a different account never unlocks this one. Passwords, tokens
 * and exception messages are never logged.</p>
 *
 * <p>Dev-only users (no Keycloak identity link) have no password; there is nothing to
 * verify, so the re-auth step is skipped. This branch exists only in the dev profile,
 * where the caller already possesses a dev session.</p>
 */
@Service
public class PasswordReauthService {

    private static final Logger log = LoggerFactory.getLogger(PasswordReauthService.class);

    private final UserIdentityRepository identities;
    private final TokenExchangePort tokenExchange;

    public PasswordReauthService(UserIdentityRepository identities,
                                 TokenExchangePort tokenExchange) {
        this.identities = identities;
        this.tokenExchange = tokenExchange;
    }

    public void requirePassword(UUID userId, String email, String password) {
        Optional<UserIdentity> identity = identities.findByUserIdAndProvider(userId,
                UserIdentity.PROVIDER_KEYCLOAK);
        if (identity.isEmpty()) {
            log.debug("Password re-auth skipped: no Keycloak identity link");
            return;
        }
        if (password == null || password.isBlank()) {
            throw reauthFailed();
        }
        try {
            TokenSet tokens = tokenExchange.passwordGrant(email, password);
            KeycloakIdentity verified = tokenExchange.userInfo(tokens.accessToken());
            if (verified.subject() == null
                    || !verified.subject().equals(identity.get().subject())) {
                throw reauthFailed();
            }
        } catch (InvalidGrantException ex) {
            throw reauthFailed();
        } catch (ProviderUnavailableException ex) {
            throw AuthBffErrors.authUnavailable("keycloak_unavailable");
        }
    }

    static DomainException reauthFailed() {
        return new DomainException(ru.krug.backend.shared.error.ErrorCategory.FORBIDDEN,
                ErrorCode.REAUTH_FAILED, "Password re-authentication failed", java.util.Map.of(),
                null);
    }
}
