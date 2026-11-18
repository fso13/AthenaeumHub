package ru.krug.backend.unit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.when;

import java.time.Instant;
import java.time.Duration;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import ru.krug.backend.auth.application.command.LoginCommand;
import ru.krug.backend.auth.application.model.AuthSessionView;
import ru.krug.backend.auth.application.model.AuthUserView;
import ru.krug.backend.auth.application.model.KeycloakIdentity;
import ru.krug.backend.auth.application.model.KeycloakUserView;
import ru.krug.backend.auth.application.model.TokenSet;
import ru.krug.backend.auth.application.port.AuthRateLimitPort;
import ru.krug.backend.auth.application.port.InvalidGrantException;
import ru.krug.backend.auth.application.port.KeycloakAdminPort;
import ru.krug.backend.auth.application.port.ProviderUnavailableException;
import ru.krug.backend.auth.application.port.TokenExchangePort;
import ru.krug.backend.auth.application.usecase.AuthSessionService;
import ru.krug.backend.auth.application.usecase.LoginService;
import ru.krug.backend.auth.domain.model.EmailVerification;
import ru.krug.backend.auth.domain.repository.EmailVerificationRepository;
import ru.krug.backend.auth.domain.repository.UserRepository;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class LoginServiceTest {

    private static final String EMAIL = "user@krug.test";
    private static final String PASSWORD = "VeryStrongPass123!";
    private static final Instant NOW = Instant.parse("2026-01-01T00:00:00Z");

    @Mock
    private AuthRateLimitPort rateLimit;
    @Mock
    private TokenExchangePort tokenExchange;
    @Mock
    private KeycloakAdminPort keycloak;
    @Mock
    private EmailVerificationRepository verifications;
    @Mock
    private UserRepository users;
    @Mock
    private AuthSessionService sessions;
    @Mock
    private ClockPort clock;

    @InjectMocks
    private LoginService service;

    @BeforeEach
    void setUp() {
        when(clock.now()).thenReturn(NOW);
        when(keycloak.findByEmail(EMAIL)).thenReturn(Optional.empty());
        when(users.findByEmail(EMAIL)).thenReturn(Optional.empty());
        when(users.findStatusByEmail(EMAIL)).thenReturn(Optional.empty());
        when(verifications.findLatestActiveByEmail(EMAIL, NOW)).thenReturn(Optional.empty());
    }

    @Test
    void successfulLoginProvisionsAndReturnsASession() {
        TokenSet tokens = new TokenSet("access", "refresh", 900, "Bearer");
        when(tokenExchange.passwordGrant(EMAIL, PASSWORD)).thenReturn(tokens);
        when(tokenExchange.userInfo("access")).thenReturn(new KeycloakIdentity("sub", EMAIL,
                true, EMAIL, "Дмитрий"));
        AuthUserView user = new AuthUserView(UUID.randomUUID(), "Дмитрий", EMAIL);
        when(sessions.session(any(), any(), anyString()))
                .thenReturn(new AuthSessionView("access", "refresh", 900, "Bearer", user));

        AuthSessionView session = service.login(new LoginCommand(" USER@krug.test ", PASSWORD),
                "127.0.0.1", "req-1");
        assertThat(session.user()).isEqualTo(user);
        assertThat(session.accessToken()).isEqualTo("access");
    }

    @Test
    void unverifiedUserIs403WithTheVerificationId() {
        UUID verificationId = UUID.randomUUID();
        when(tokenExchange.passwordGrant(EMAIL, PASSWORD)).thenThrow(new InvalidGrantException());
        when(keycloak.findByEmail(EMAIL)).thenReturn(Optional.of(new KeycloakUserView(
                UUID.randomUUID(), EMAIL, EMAIL, "User", false, false)));
        when(verifications.findLatestActiveByEmail(EMAIL, NOW)).thenReturn(Optional.of(
                EmailVerification.create(verificationId, EMAIL, "User", UUID.randomUUID(),
                        "secret", NOW.plus(Duration.ofMinutes(10)), NOW)));

        assertThatThrownBy(() -> service.login(new LoginCommand(EMAIL, PASSWORD),
                "127.0.0.1", "req-1"))
                .isInstanceOfSatisfying(DomainException.class, ex -> {
                    assertThat(ex.code()).isEqualTo(ErrorCode.EMAIL_NOT_VERIFIED);
                    assertThat(ex.details()).containsEntry("verification_id",
                            verificationId.toString());
                });
    }

    @Test
    void wrongPasswordOnAnEnabledUserIs401() {
        when(tokenExchange.passwordGrant(EMAIL, "wrong")).thenThrow(new InvalidGrantException());
        when(keycloak.findByEmail(EMAIL)).thenReturn(Optional.of(new KeycloakUserView(
                UUID.randomUUID(), EMAIL, EMAIL, "User", true, true)));

        assertThatThrownBy(() -> service.login(new LoginCommand(EMAIL, "wrong"),
                "127.0.0.1", "req-1"))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.code()).isEqualTo(ErrorCode.INVALID_CREDENTIALS));
    }

    @Test
    void providerFailureAndRateLimitMapToContractualErrors() {
        when(tokenExchange.passwordGrant(EMAIL, PASSWORD))
                .thenThrow(new ProviderUnavailableException());
        assertThatThrownBy(() -> service.login(new LoginCommand(EMAIL, PASSWORD),
                "127.0.0.1", "req-1"))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.code()).isEqualTo(ErrorCode.AUTH_UNAVAILABLE));

        doThrow(DomainException.rateLimited(30, Map.of("scope", "email")))
                .when(rateLimit).checkLogin(EMAIL, "127.0.0.1");
        assertThatThrownBy(() -> service.login(new LoginCommand(EMAIL, PASSWORD),
                "127.0.0.1", "req-1"))
                .isInstanceOfSatisfying(DomainException.class,
                        ex -> assertThat(ex.code()).isEqualTo(ErrorCode.RATE_LIMITED));
    }
}
