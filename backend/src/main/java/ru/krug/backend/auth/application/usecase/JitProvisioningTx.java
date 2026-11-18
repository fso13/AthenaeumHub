package ru.krug.backend.auth.application.usecase;

import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.auth.application.model.AuthenticatedUser;
import ru.krug.backend.auth.application.model.KeycloakIdentity;
import ru.krug.backend.auth.application.service.KeycloakIdentityFactory;
import ru.krug.backend.auth.domain.model.DisplayName;
import ru.krug.backend.auth.domain.model.User;
import ru.krug.backend.auth.domain.model.UserIdentity;
import ru.krug.backend.auth.domain.repository.UserIdentityRepository;
import ru.krug.backend.auth.domain.repository.UserRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;

/**
 * One transaction of the JIT flow. Kept separate from {@link JitProvisioningService} so a
 * unique-email collision can be retried in a fresh transaction.
 */
@Service
public class JitProvisioningTx {

    private final TenantContext tenantContext;
    private final UserRepository userRepository;
    private final UserIdentityRepository identityRepository;
    private final KeycloakIdentityFactory identities;
    private final AuditPort audit;
    private final ClockPort clock;

    public JitProvisioningTx(TenantContext tenantContext, UserRepository userRepository,
                             UserIdentityRepository identityRepository,
                             KeycloakIdentityFactory identities, AuditPort audit,
                             ClockPort clock) {
        this.tenantContext = tenantContext;
        this.userRepository = userRepository;
        this.identityRepository = identityRepository;
        this.identities = identities;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public AuthenticatedUser ensure(KeycloakIdentity identity, String requestId, String email) {
        UUID userId = identities.localUserId(identity.subject());
        tenantContext.activate(new Principal(userId, null, null, requestId));

        Optional<UserIdentity> existing = identityRepository.findByProviderAndSubject(
                UserIdentity.PROVIDER_KEYCLOAK, identity.subject());
        if (existing.isPresent()) {
            return profile(userRepository.findById(existing.get().userId())
                    .orElseThrow(() -> DomainException.forbidden("User is not available")));
        }

        User user = User.provision(userId, email, new DisplayName(identities.displayName(identity)),
                userRepository.claimPlatformAdmin());
        userRepository.save(user);
        boolean created = identityRepository.insertIfAbsent(new UserIdentity(UUID.randomUUID(),
                userId, UserIdentity.PROVIDER_KEYCLOAK, identity.subject()));
        if (!created) {
            UserIdentity winner = identityRepository.findByProviderAndSubject(
                            UserIdentity.PROVIDER_KEYCLOAK, identity.subject())
                    .orElseThrow(() -> DomainException.internal());
            return profile(userRepository.findById(winner.userId())
                    .orElseThrow(() -> DomainException.internal()));
        }

        audit.append(new AuditRecord(null, userId, "user.provisioned", "user", userId,
                requestId, Map.of("provider", UserIdentity.PROVIDER_KEYCLOAK), clock.now()));
        return profile(user);
    }

    private static AuthenticatedUser profile(User user) {
        if (!user.isActive()) {
            throw DomainException.forbidden("User is not active");
        }
        return new AuthenticatedUser(user.id(), user.displayName().value(), user.email(),
                user.isPlatformAdmin());
    }
}
