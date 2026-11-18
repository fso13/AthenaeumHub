package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.auth.application.model.AuthenticatedUser;
import ru.krug.backend.auth.application.model.KeycloakIdentity;
import ru.krug.backend.auth.application.service.KeycloakIdentityFactory;
import ru.krug.backend.auth.application.usecase.JitProvisioningTx;
import ru.krug.backend.auth.domain.model.DisplayName;
import ru.krug.backend.auth.domain.model.User;
import ru.krug.backend.auth.domain.model.UserIdentity;
import ru.krug.backend.auth.domain.repository.UserIdentityRepository;
import ru.krug.backend.auth.domain.repository.UserRepository;
import ru.krug.backend.shared.application.port.TenantContext;

class JitProvisioningTxTest {

    private static final Instant NOW = Instant.parse("2026-01-01T10:00:00Z");
    private static final KeycloakIdentity IDENTITY = new KeycloakIdentity("kc-subject",
            "user@example.com", true, "user", "User Name");

    @Test
    void firstLoginCreatesUserIdentityAndAudit() {
        TenantContext tenant = mock(TenantContext.class);
        UserRepository users = mock(UserRepository.class);
        UserIdentityRepository identities = mock(UserIdentityRepository.class);
        AuditPort audit = mock(AuditPort.class);
        when(identities.findByProviderAndSubject("keycloak", "kc-subject"))
                .thenReturn(Optional.empty());
        when(identities.insertIfAbsent(any())).thenReturn(true);
        JitProvisioningTx tx = new JitProvisioningTx(tenant, users, identities,
                new KeycloakIdentityFactory(), audit, () -> NOW);

        AuthenticatedUser result = tx.ensure(IDENTITY, "req-1", "user@example.com");

        ArgumentCaptor<User> userCaptor = ArgumentCaptor.forClass(User.class);
        verify(users).save(userCaptor.capture());
        User user = userCaptor.getValue();
        assertThat(user.id()).isEqualTo(new KeycloakIdentityFactory().localUserId("kc-subject"));
        assertThat(user.email()).isEqualTo("user@example.com");
        assertThat(user.displayName().value()).isEqualTo("User Name");
        assertThat(result.userId()).isEqualTo(user.id());

        ArgumentCaptor<UserIdentity> identityCaptor =
                ArgumentCaptor.forClass(UserIdentity.class);
        verify(identities).insertIfAbsent(identityCaptor.capture());
        assertThat(identityCaptor.getValue().provider()).isEqualTo("keycloak");
        assertThat(identityCaptor.getValue().subject()).isEqualTo("kc-subject");
        assertThat(identityCaptor.getValue().userId()).isEqualTo(user.id());

        verify(audit).append(any());
        verify(tenant).activate(any());
    }

    @Test
    void existingIdentityDoesNotCreateOrAuditAgain() {
        TenantContext tenant = mock(TenantContext.class);
        UserRepository users = mock(UserRepository.class);
        UserIdentityRepository identities = mock(UserIdentityRepository.class);
        AuditPort audit = mock(AuditPort.class);
        UUID userId = UUID.randomUUID();
        User existing = User.reconstitute(userId, "user@example.com",
                new DisplayName("Existing"), User.Status.ACTIVE);
        when(identities.findByProviderAndSubject("keycloak", "kc-subject"))
                .thenReturn(Optional.of(new UserIdentity(UUID.randomUUID(), userId, "keycloak",
                        "kc-subject")));
        when(users.findById(userId)).thenReturn(Optional.of(existing));
        JitProvisioningTx tx = new JitProvisioningTx(tenant, users, identities,
                new KeycloakIdentityFactory(), audit, () -> NOW);

        AuthenticatedUser result = tx.ensure(IDENTITY, "req-2", "user@example.com");

        assertThat(result.userId()).isEqualTo(userId);
        assertThat(result.displayName()).isEqualTo("Existing");
        verify(users, never()).save(any());
        verify(identities, never()).insertIfAbsent(any());
        verify(audit, never()).append(any());
    }

    @Test
    void suspendedUserIsForbidden() {
        TenantContext tenant = mock(TenantContext.class);
        UserRepository users = mock(UserRepository.class);
        UserIdentityRepository identities = mock(UserIdentityRepository.class);
        AuditPort audit = mock(AuditPort.class);
        UUID userId = UUID.randomUUID();
        when(identities.findByProviderAndSubject(anyString(), anyString()))
                .thenReturn(Optional.of(new UserIdentity(UUID.randomUUID(), userId, "keycloak",
                        "kc-subject")));
        when(users.findById(userId)).thenReturn(Optional.of(User.reconstitute(userId,
                "user@example.com", new DisplayName("Suspended"), User.Status.SUSPENDED)));
        JitProvisioningTx tx = new JitProvisioningTx(tenant, users, identities,
                new KeycloakIdentityFactory(), audit, () -> NOW);

        org.assertj.core.api.Assertions.assertThatThrownBy(() -> tx.ensure(IDENTITY, "req",
                        "user@example.com"))
                .isInstanceOf(ru.krug.backend.shared.error.DomainException.class)
                .hasMessageContaining("not active");
    }

    @Test
    void firstJitUserClaimsPlatformAdminInTheProvisioningTransaction() {
        TenantContext tenant = mock(TenantContext.class);
        UserRepository users = mock(UserRepository.class);
        UserIdentityRepository identities = mock(UserIdentityRepository.class);
        AuditPort audit = mock(AuditPort.class);
        when(identities.findByProviderAndSubject("keycloak", "kc-subject"))
                .thenReturn(Optional.empty());
        when(identities.insertIfAbsent(any())).thenReturn(true);
        when(users.claimPlatformAdmin()).thenReturn(true);
        JitProvisioningTx tx = new JitProvisioningTx(tenant, users, identities,
                new KeycloakIdentityFactory(), audit, () -> NOW);

        AuthenticatedUser result = tx.ensure(IDENTITY, "req-admin", "user@example.com");

        ArgumentCaptor<User> userCaptor = ArgumentCaptor.forClass(User.class);
        verify(users).save(userCaptor.capture());
        assertThat(userCaptor.getValue().isPlatformAdmin()).isTrue();
        assertThat(result.platformAdmin()).isTrue();
    }
}
