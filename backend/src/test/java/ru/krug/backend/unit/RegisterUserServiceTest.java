package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import ru.krug.backend.auth.application.command.RegisterCommand;
import ru.krug.backend.auth.application.model.EmailCodeMessage;
import ru.krug.backend.auth.application.model.KeycloakUserView;
import ru.krug.backend.auth.application.model.RegistrationView;
import ru.krug.backend.auth.application.model.TokenSet;
import ru.krug.backend.auth.application.port.AuthBffSettings;
import ru.krug.backend.auth.application.port.AuthRateLimitPort;
import ru.krug.backend.auth.application.port.EmailCodePort;
import ru.krug.backend.auth.application.port.KeycloakAdminPort;
import ru.krug.backend.auth.application.port.MailDeliveryException;
import ru.krug.backend.auth.application.port.MailPort;
import ru.krug.backend.auth.application.port.PasswordRejectedException;
import ru.krug.backend.auth.application.port.PendingSessionPort;
import ru.krug.backend.auth.application.port.TokenExchangePort;
import ru.krug.backend.auth.application.usecase.RegisterUserService;
import ru.krug.backend.auth.domain.model.EmailVerification;
import ru.krug.backend.auth.domain.repository.EmailVerificationRepository;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class RegisterUserServiceTest {

    private static final Instant NOW = Instant.parse("2026-01-01T00:00:00Z");
    private static final UUID KEYCLOAK_ID = UUID.randomUUID();
    private static final String EMAIL = "user@krug.test";
    private static final String PASSWORD = "VeryStrongPass123!";

    @Mock
    private AuthBffSettings settings;
    @Mock
    private AuthRateLimitPort rateLimit;
    @Mock
    private KeycloakAdminPort keycloak;
    @Mock
    private TokenExchangePort tokenExchange;
    @Mock
    private EmailCodePort emailCode;
    @Mock
    private MailPort mail;
    @Mock
    private EmailVerificationRepository verifications;
    @Mock
    private PendingSessionPort pendingSessions;
    @Mock
    private ClockPort clock;

    @InjectMocks
    private RegisterUserService service;

    @BeforeEach
    void setUp() {
        when(settings.registrationEnabled()).thenReturn(true);
        when(settings.codeExpiry()).thenReturn(Duration.ofMinutes(10));
        when(settings.resendCooldown()).thenReturn(Duration.ofSeconds(60));
        when(settings.pendingSessionTtl()).thenReturn(Duration.ofMinutes(15));
        when(clock.now()).thenReturn(NOW);
        when(emailCode.newSecret()).thenReturn("secret");
        when(emailCode.code("secret", NOW)).thenReturn("123456");
        when(keycloak.findByEmail(EMAIL)).thenReturn(Optional.empty());
        when(keycloak.createUser(EMAIL, "Дмитрий")).thenReturn(KEYCLOAK_ID);
        when(tokenExchange.passwordGrant(EMAIL, PASSWORD))
                .thenReturn(new TokenSet("access", "refresh", 900, "Bearer"));
    }

    @Test
    void createsDisabledKeycloakUserStoresEncryptedSecretAndSendsCode() {
        RegistrationView view = service.register(
                new RegisterCommand(EMAIL, " Дмитрий ", PASSWORD), "127.0.0.1");

        assertThat(view.verificationId()).isNotNull();
        assertThat(view.expiresIn()).isEqualTo(600);
        assertThat(view.resendAfter()).isEqualTo(60);

        verify(keycloak).setPassword(KEYCLOAK_ID, PASSWORD);
        verify(keycloak).updateEnabledAndVerified(KEYCLOAK_ID, true, false);
        verify(keycloak).updateEnabledAndVerified(KEYCLOAK_ID, false, false);

        ArgumentCaptor<EmailVerification> row = ArgumentCaptor.forClass(EmailVerification.class);
        verify(verifications).save(row.capture());
        assertThat(row.getValue().email()).isEqualTo(EMAIL);
        assertThat(row.getValue().displayName()).isEqualTo("Дмитрий");
        assertThat(row.getValue().expiresAt()).isEqualTo(NOW.plus(Duration.ofMinutes(10)));
        assertThat(row.getValue().consumedAt()).isNull();

        ArgumentCaptor<EmailCodeMessage> message = ArgumentCaptor.forClass(EmailCodeMessage.class);
        verify(mail).sendEmailCode(message.capture());
        assertThat(message.getValue().code()).isEqualTo("123456");
        assertThat(message.getValue().email()).isEqualTo(EMAIL);
        verify(pendingSessions).store(eq(view.verificationId()), eq("refresh"), any());
        verify(keycloak, never()).deleteUser(any());
    }

    @Test
    void duplicateEmailIs409WithoutTouchingKeycloakUsers() {
        when(keycloak.findByEmail(EMAIL)).thenReturn(Optional.of(new KeycloakUserView(
                KEYCLOAK_ID, EMAIL, EMAIL, "User", true, true)));

        assertThatThrownBy(() -> service.register(
                new RegisterCommand(EMAIL, "Дмитрий", PASSWORD), "127.0.0.1"))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.code()).isEqualTo(ErrorCode.EMAIL_TAKEN));
        verify(keycloak, never()).createUser(anyString(), anyString());
        verifyNoInteractions(mail);
    }

    @Test
    void mailFailureRollsTheKeycloakUserBack() {
        doThrow(new MailDeliveryException()).when(mail).sendEmailCode(any());

        assertThatThrownBy(() -> service.register(
                new RegisterCommand(EMAIL, "Дмитрий", PASSWORD), "127.0.0.1"))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.code()).isEqualTo(ErrorCode.AUTH_UNAVAILABLE));
        verify(keycloak).deleteUser(KEYCLOAK_ID);
        verify(tokenExchange).revoke("refresh");
        verify(pendingSessions).discard(any());
    }

    @Test
    void rejectedPasswordRollsTheKeycloakUserBack() {
        doThrow(new PasswordRejectedException()).when(keycloak)
                .setPassword(KEYCLOAK_ID, PASSWORD);

        assertThatThrownBy(() -> service.register(
                new RegisterCommand(EMAIL, "Дмитрий", PASSWORD), "127.0.0.1"))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.code()).isEqualTo(ErrorCode.VALIDATION_FAILED));
        verify(keycloak).deleteUser(KEYCLOAK_ID);
    }

    @Test
    void closedRegistrationAndRateLimitAreEnforcedBeforeKeycloak() {
        when(settings.registrationEnabled()).thenReturn(false);
        assertThatThrownBy(() -> service.register(
                new RegisterCommand(EMAIL, "Дмитрий", PASSWORD), "127.0.0.1"))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.code()).isEqualTo(ErrorCode.REGISTRATION_CLOSED));

        when(settings.registrationEnabled()).thenReturn(true);
        doThrow(DomainException.rateLimited(30, Map.of("scope", "email")))
                .when(rateLimit).checkRegister(EMAIL, "127.0.0.1");
        assertThatThrownBy(() -> service.register(
                new RegisterCommand(EMAIL, "Дмитрий", PASSWORD), "127.0.0.1"))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.code()).isEqualTo(ErrorCode.RATE_LIMITED));
        verifyNoInteractions(keycloak);
    }
}
