package ru.krug.backend.auth.application.usecase;

import org.springframework.stereotype.Service;

import ru.krug.backend.auth.application.model.AuthSessionView;
import ru.krug.backend.auth.application.model.AuthUserView;
import ru.krug.backend.auth.application.model.KeycloakIdentity;
import ru.krug.backend.auth.application.model.TokenSet;
import ru.krug.backend.auth.application.port.JitProvisioningPort;
import ru.krug.backend.auth.application.model.AuthenticatedUser;

/**
 * Converts a Keycloak token pair into the public AuthSession. JIT-provisions the local
 * user so {@code AuthSession.user.id} matches {@code GET /me}.
 */
@Service
public class AuthSessionService {

    private final JitProvisioningPort jitProvisioning;

    public AuthSessionService(JitProvisioningPort jitProvisioning) {
        this.jitProvisioning = jitProvisioning;
    }

    public AuthSessionView session(KeycloakIdentity identity, TokenSet tokens,
                                   String requestId) {
        AuthenticatedUser user = jitProvisioning.ensure(identity, requestId);
        return new AuthSessionView(tokens.accessToken(), tokens.refreshToken(),
                tokens.expiresIn(), "Bearer",
                new AuthUserView(user.userId(), user.displayName(), user.email(),
                        user.platformAdmin()));
    }
}
