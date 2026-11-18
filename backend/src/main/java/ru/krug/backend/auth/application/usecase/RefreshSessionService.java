package ru.krug.backend.auth.application.usecase;

import org.springframework.stereotype.Service;

import ru.krug.backend.auth.application.model.AuthSessionView;
import ru.krug.backend.auth.application.model.KeycloakIdentity;
import ru.krug.backend.auth.application.model.TokenSet;
import ru.krug.backend.auth.application.port.InvalidGrantException;
import ru.krug.backend.auth.application.port.ProviderUnavailableException;
import ru.krug.backend.auth.application.port.TokenExchangePort;

/** {@code POST /auth/refresh}: Keycloak rotates the access/refresh pair. */
@Service
public class RefreshSessionService {

    private final TokenExchangePort tokenExchange;
    private final AuthSessionService sessions;

    public RefreshSessionService(TokenExchangePort tokenExchange, AuthSessionService sessions) {
        this.tokenExchange = tokenExchange;
        this.sessions = sessions;
    }

    public AuthSessionView refresh(String refreshToken, String requestId) {
        try {
            TokenSet tokens = tokenExchange.refresh(refreshToken);
            KeycloakIdentity identity = tokenExchange.userInfo(tokens.accessToken());
            if (!identity.emailVerified()) {
                throw AuthBffErrors.emailNotVerified(null);
            }
            return sessions.session(identity, tokens, requestId);
        } catch (InvalidGrantException ex) {
            throw AuthBffErrors.invalidCredentials();
        } catch (ProviderUnavailableException ex) {
            throw AuthBffErrors.authUnavailable("keycloak_unavailable");
        }
    }
}
