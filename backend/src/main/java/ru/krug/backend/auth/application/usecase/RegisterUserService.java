package ru.krug.backend.auth.application.usecase;

import java.time.Instant;
import java.util.UUID;

import org.springframework.stereotype.Service;

import ru.krug.backend.auth.application.command.RegisterCommand;
import ru.krug.backend.auth.application.model.EmailCodeMessage;
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
import ru.krug.backend.auth.application.port.ProviderUnavailableException;
import ru.krug.backend.auth.application.port.TokenExchangePort;
import ru.krug.backend.auth.application.port.UserAlreadyExistsException;
import ru.krug.backend.auth.application.service.KeycloakIdentityFactory;
import ru.krug.backend.auth.domain.model.EmailVerification;
import ru.krug.backend.auth.domain.repository.EmailVerificationRepository;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.domain.model.TokenDigest;
import ru.krug.backend.shared.error.DomainException;

/**
 * {@code POST /auth/register}: create a disabled Keycloak user, send a TOTP code and keep
 * only the encrypted secret locally. The password is forwarded to Keycloak and is never
 * stored or logged by the BFF.
 *
 * <p>A token pair is obtained while the user is briefly enabled and cached server-side so
 * {@code /auth/verify-email} can return a session without the password. The user is
 * immediately disabled again; the cached refresh token is unusable while disabled.</p>
 */
@Service
public class RegisterUserService {

    private final AuthBffSettings settings;
    private final AuthRateLimitPort rateLimit;
    private final KeycloakAdminPort keycloak;
    private final TokenExchangePort tokenExchange;
    private final EmailCodePort emailCode;
    private final MailPort mail;
    private final EmailVerificationRepository verifications;
    private final PendingSessionPort pendingSessions;
    private final ClockPort clock;

    public RegisterUserService(AuthBffSettings settings, AuthRateLimitPort rateLimit,
                               KeycloakAdminPort keycloak, TokenExchangePort tokenExchange,
                               EmailCodePort emailCode, MailPort mail,
                               EmailVerificationRepository verifications,
                               PendingSessionPort pendingSessions, ClockPort clock) {
        this.settings = settings;
        this.rateLimit = rateLimit;
        this.keycloak = keycloak;
        this.tokenExchange = tokenExchange;
        this.emailCode = emailCode;
        this.mail = mail;
        this.verifications = verifications;
        this.pendingSessions = pendingSessions;
        this.clock = clock;
    }

    public RegistrationView register(RegisterCommand command, String clientIp) {
        if (!settings.registrationEnabled()) {
            throw AuthBffErrors.registrationClosed();
        }
        String email = EmailVerification.normalizeEmail(command.email());
        if (email == null || !KeycloakIdentityFactory.isEmail(email)) {
            throw DomainException.badRequest("email is invalid", java.util.Map.of("field", "email"));
        }
        if (command.displayName() == null || command.displayName().isBlank()
                || command.displayName().strip().length() > 80) {
            throw DomainException.badRequest("display_name is invalid",
                    java.util.Map.of("field", "display_name"));
        }
        if (command.password() == null || command.password().length() < 10
                || command.password().length() > 128) {
            throw DomainException.badRequest("password must be 10..128 characters",
                    java.util.Map.of("field", "password"));
        }
        rateLimit.checkRegister(email, clientIp);

        // #100: keep only the digest; a malformed token is simply not claimable and must not
        // change the registration response (no account/invite enumeration).
        String inviteToken = command.inviteToken() == null ? null : command.inviteToken().strip();
        String inviteTokenHash = TokenDigest.isWellFormed(inviteToken)
                ? TokenDigest.sha256Hex(inviteToken) : null;

        try {
            if (keycloak.findByEmail(email).isPresent()) {
                throw AuthBffErrors.emailTaken();
            }
        } catch (ProviderUnavailableException ex) {
            throw AuthBffErrors.authUnavailable("keycloak_unavailable");
        } catch (DomainException ex) {
            throw ex;
        }

        Instant now = clock.now();
        UUID verificationId = UUID.randomUUID();
        String secret = emailCode.newSecret();
        String code = emailCode.code(secret, now);
        Instant expiresAt = now.plus(settings.codeExpiry());

        UUID keycloakUserId = null;
        String pendingRefreshToken = null;
        boolean rowSaved = false;
        try {
            keycloakUserId = keycloak.createUser(email, command.displayName().strip());
            keycloak.setPassword(keycloakUserId, command.password());
            // Password grant is only possible while enabled; immediately disable again.
            keycloak.updateEnabledAndVerified(keycloakUserId, true, false);
            TokenSet tokens = tokenExchange.passwordGrant(email, command.password());
            pendingRefreshToken = tokens.refreshToken();
            keycloak.updateEnabledAndVerified(keycloakUserId, false, false);

            EmailVerification verification = EmailVerification.create(verificationId, email,
                    command.displayName().strip(), keycloakUserId, secret, expiresAt, now,
                    inviteTokenHash);
            verifications.save(verification);
            rowSaved = true;
            pendingSessions.store(verificationId, pendingRefreshToken,
                    now.plus(settings.pendingSessionTtl()));

            mail.sendEmailCode(new EmailCodeMessage(email, verification.displayName(), code,
                    (int) Math.max(1, settings.codeExpiry().toMinutes())));
            return new RegistrationView(verificationId,
                    Math.max(1, settings.codeExpiry().toSeconds()),
                    Math.max(0, settings.resendCooldown().toSeconds()));
        } catch (UserAlreadyExistsException ex) {
            rollback(keycloakUserId, verificationId, rowSaved, pendingRefreshToken);
            throw AuthBffErrors.emailTaken();
        } catch (PasswordRejectedException ex) {
            rollback(keycloakUserId, verificationId, rowSaved, pendingRefreshToken);
            throw AuthBffErrors.passwordRejected();
        } catch (MailDeliveryException ex) {
            rollback(keycloakUserId, verificationId, rowSaved, pendingRefreshToken);
            throw AuthBffErrors.authUnavailable("mail_unavailable");
        } catch (ProviderUnavailableException ex) {
            rollback(keycloakUserId, verificationId, rowSaved, pendingRefreshToken);
            throw AuthBffErrors.authUnavailable("keycloak_unavailable");
        } catch (DomainException ex) {
            rollback(keycloakUserId, verificationId, rowSaved, pendingRefreshToken);
            throw ex;
        } catch (RuntimeException ex) {
            rollback(keycloakUserId, verificationId, rowSaved, pendingRefreshToken);
            throw ex;
        }
    }

    private void rollback(UUID keycloakUserId, UUID verificationId, boolean rowSaved,
                          String pendingRefreshToken) {
        if (rowSaved) {
            quietly(() -> verifications.delete(verificationId));
        }
        pendingSessions.discard(verificationId);
        if (pendingRefreshToken != null) {
            quietly(() -> tokenExchange.revoke(pendingRefreshToken));
        }
        if (keycloakUserId != null) {
            quietly(() -> keycloak.deleteUser(keycloakUserId));
        }
    }

    private static void quietly(Runnable action) {
        try {
            action.run();
        } catch (RuntimeException ignored) {
            // Rollback is best-effort; never mask the original failure.
        }
    }
}
