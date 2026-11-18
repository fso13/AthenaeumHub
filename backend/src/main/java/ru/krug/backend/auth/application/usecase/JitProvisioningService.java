package ru.krug.backend.auth.application.usecase;

import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;

import ru.krug.backend.auth.application.model.AuthenticatedUser;
import ru.krug.backend.auth.application.model.KeycloakIdentity;
import ru.krug.backend.auth.application.port.JitProvisioningPort;
import ru.krug.backend.auth.application.service.KeycloakIdentityFactory;

/**
 * JIT provisioning entry point. First login creates the local user, the identity link and
 * a {@code user.provisioned} audit event; later logins only read the mapping.
 */
@Service
public class JitProvisioningService implements JitProvisioningPort {

    private final JitProvisioningTx transaction;
    private final KeycloakIdentityFactory identities;

    public JitProvisioningService(JitProvisioningTx transaction,
                                  KeycloakIdentityFactory identities) {
        this.transaction = transaction;
        this.identities = identities;
    }

    @Override
    public AuthenticatedUser ensure(KeycloakIdentity identity, String requestId) {
        if (identity.subject() == null || identity.subject().isBlank()) {
            throw new IllegalArgumentException("OIDC subject is required");
        }
        try {
            return transaction.ensure(identity, requestId, identities.email(identity));
        } catch (DataIntegrityViolationException collision) {
            // An existing local user already owns this email. Never link accounts by email;
            // give the Keycloak user a deterministic local address instead.
            return transaction.ensure(identity, requestId, identities.collisionEmail(identity));
        }
    }
}
