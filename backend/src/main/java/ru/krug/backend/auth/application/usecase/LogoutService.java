package ru.krug.backend.auth.application.usecase;

import org.springframework.stereotype.Service;

import ru.krug.backend.auth.application.port.TokenExchangePort;

/**
 * {@code POST /auth/logout}: revokes the Keycloak refresh token. Always idempotent — a
 * token that is already invalid is treated as logged out.
 */
@Service
public class LogoutService {

    private final TokenExchangePort tokenExchange;

    public LogoutService(TokenExchangePort tokenExchange) {
        this.tokenExchange = tokenExchange;
    }

    public void logout(String refreshToken) {
        try {
            tokenExchange.revoke(refreshToken);
        } catch (RuntimeException ignored) {
            // Logout must never reveal whether a token was valid, nor fail the client.
        }
    }
}
