package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;

import ru.krug.backend.auth.application.model.AuthenticatedUser;
import ru.krug.backend.auth.application.model.KeycloakIdentity;
import ru.krug.backend.auth.application.service.KeycloakIdentityFactory;
import ru.krug.backend.auth.application.usecase.JitProvisioningService;
import ru.krug.backend.auth.application.usecase.JitProvisioningTx;

class JitProvisioningServiceTest {

    private static final KeycloakIdentity IDENTITY = new KeycloakIdentity("subject",
            "user@example.com", true, "user", "User");

    @Test
    void retriesWithCollisionEmailWhenEmailIsAlreadyTaken() {
        JitProvisioningTx tx = mock(JitProvisioningTx.class);
        KeycloakIdentityFactory factory = mock(KeycloakIdentityFactory.class);
        when(factory.email(IDENTITY)).thenReturn("user@example.com");
        when(factory.collisionEmail(IDENTITY)).thenReturn("user.abc@keycloak.local");
        AuthenticatedUser expected = new AuthenticatedUser(UUID.randomUUID(), "User",
                "user.abc@keycloak.local");
        when(tx.ensure(eq(IDENTITY), eq("req"), anyString()))
                .thenThrow(new DataIntegrityViolationException("duplicate email"))
                .thenReturn(expected);
        JitProvisioningService service = new JitProvisioningService(tx, factory);

        AuthenticatedUser result = service.ensure(IDENTITY, "req");

        assertThat(result).isEqualTo(expected);
        verify(tx).ensure(IDENTITY, "req", "user@example.com");
        verify(tx).ensure(IDENTITY, "req", "user.abc@keycloak.local");
    }

    @Test
    void rejectsMissingSubject() {
        JitProvisioningService service = new JitProvisioningService(
                mock(JitProvisioningTx.class), new KeycloakIdentityFactory());
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> service.ensure(
                        new KeycloakIdentity("", null, false, "u", "U"), "req"))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
