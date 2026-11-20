package ru.krug.backend.auth.application.usecase;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.auth.application.model.AuthSessionView;
import ru.krug.backend.auth.application.model.TwoFactorChallengeView;
import ru.krug.backend.auth.application.model.TwoFactorRecoveryCodesView;
import ru.krug.backend.auth.application.model.TwoFactorSetupView;
import ru.krug.backend.auth.application.model.TwoFactorStatusView;
import ru.krug.backend.auth.application.port.AuthBffSettings;
import ru.krug.backend.auth.application.port.AuthRateLimitPort;
import ru.krug.backend.auth.application.port.TwoFactorChallengePort;
import ru.krug.backend.auth.application.service.KeycloakIdentityFactory;
import ru.krug.backend.auth.domain.model.TwoFactorSettings;
import ru.krug.backend.auth.domain.model.User;
import ru.krug.backend.auth.domain.repository.RecoveryCodeRepository;
import ru.krug.backend.auth.domain.repository.TwoFactorRepository;
import ru.krug.backend.auth.domain.repository.UserRepository;
import ru.krug.backend.auth.domain.service.RecoveryCodes;
import ru.krug.backend.auth.domain.service.TotpCode;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * TOTP authenticator self-service and the login second factor (P0-4 / #82).
 *
 * <p>Security invariants:</p>
 * <ul>
 *   <li>the plaintext secret is returned exactly once by setup and is never logged,
 *       audited or returned by verify/status; at rest it is AES-GCM ciphertext;</li>
 *   <li>setup, disable and recovery-code regeneration require the account password
 *       (Keycloak re-auth bound to the caller's own subject);</li>
 *   <li>disable requires a valid TOTP code or a one-time recovery code on top of the
 *       password, so a stolen session token alone cannot remove the second factor;</li>
 *   <li>recovery codes are hashed, single-use and replaced as a whole;</li>
 *   <li>an accepted TOTP step is persisted, so the same code cannot be replayed;</li>
 *   <li>every attempt is rate-limited per user and client IP.</li>
 * </ul>
 */
@Service
public class TwoFactorService {

    static final String ACTION_ENABLED = "2fa.enabled";
    static final String ACTION_DISABLED = "2fa.disabled";
    static final String ACTION_RECOVERY_REGENERATED = "2fa.recovery_codes.regenerated";
    static final String ACTION_LOGIN_VERIFIED = "2fa.login.verified";

    private static final String PROVIDER_LABEL = "Krug";
    private static final int SECRET_BYTES = 20;
    private static final SecureRandom RANDOM = new SecureRandom();

    private final TenantContext tenantContext;
    private final UserRepository users;
    private final TwoFactorRepository twoFactor;
    private final RecoveryCodeRepository recoveryCodes;
    private final PasswordReauthService reauth;
    private final AuthRateLimitPort rateLimit;
    private final TwoFactorChallengePort challenges;
    private final AuthSessionService sessions;
    private final AuthBffSettings settings;
    private final AuditPort audit;
    private final ClockPort clock;

    public TwoFactorService(TenantContext tenantContext, UserRepository users,
                            TwoFactorRepository twoFactor,
                            RecoveryCodeRepository recoveryCodes, PasswordReauthService reauth,
                            AuthRateLimitPort rateLimit, TwoFactorChallengePort challenges,
                            AuthSessionService sessions, AuthBffSettings settings,
                            AuditPort audit, ClockPort clock) {
        this.tenantContext = tenantContext;
        this.users = users;
        this.twoFactor = twoFactor;
        this.recoveryCodes = recoveryCodes;
        this.reauth = reauth;
        this.rateLimit = rateLimit;
        this.challenges = challenges;
        this.sessions = sessions;
        this.settings = settings;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public TwoFactorSetupView setup(Principal principal, String password, String clientIp) {
        rateLimit.checkTwoFactor(principal.userId().toString(), clientIp);
        tenantContext.activate(principal.withWorkspace(null));
        User user = users.findById(principal.userId())
                .orElseThrow(() -> DomainException.notFound("User not found"));
        Optional<TwoFactorSettings> existing = twoFactor.find(user.id());
        if (existing.filter(TwoFactorSettings::isEnabled).isPresent()) {
            throw DomainException.conflict(ErrorCode.TWO_FACTOR_ALREADY_ENABLED,
                    "Two-factor authentication is already enabled", Map.of());
        }
        reauth.requirePassword(user.id(), user.email(), password);

        String secret = newSecret();
        twoFactor.savePending(user.id(), secret, clock.now());
        String uri = otpauthUri(user.email(), secret);
        return new TwoFactorSetupView(secret, uri, uri);
    }

    @Transactional
    public TwoFactorStatusView verify(Principal principal, String code, String clientIp) {
        rateLimit.checkTwoFactor(principal.userId().toString(), clientIp);
        tenantContext.activate(principal.withWorkspace(null));
        TwoFactorSettings current = twoFactor.find(principal.userId())
                .orElseThrow(() -> DomainException.conflict(ErrorCode.TWO_FACTOR_NOT_SETUP,
                        "Two-factor setup has not been started", Map.of()));
        if (current.isEnabled()) {
            throw DomainException.conflict(ErrorCode.TWO_FACTOR_ALREADY_ENABLED,
                    "Two-factor authentication is already enabled", Map.of());
        }
        long step = TotpCode.matchedStep(current.secret(), code, epochSecond(),
                settings.twoFactorWindow());
        if (step < 0) {
            throw DomainException.unprocessable(ErrorCode.TWO_FACTOR_CODE_INVALID,
                    "The authenticator code is invalid", Map.of("field", "code"));
        }
        twoFactor.enable(principal.userId(), clock.now());
        twoFactor.updateLastUsedStep(principal.userId(), step, clock.now());
        audit.append(new AuditRecord(null, principal.userId(), ACTION_ENABLED, "user",
                principal.userId(), principal.requestId(), Map.of(), clock.now()));
        return new TwoFactorStatusView(true, clock.now(), 0L);
    }

    @Transactional(readOnly = true)
    public TwoFactorStatusView status(Principal principal) {
        tenantContext.activate(principal.withWorkspace(null));
        Optional<TwoFactorSettings> settingsValue = twoFactor.find(principal.userId());
        if (settingsValue.isEmpty() || !settingsValue.get().isEnabled()) {
            return new TwoFactorStatusView(false, null, recoveryCodes.countRemaining(
                    principal.userId()));
        }
        return new TwoFactorStatusView(true, settingsValue.get().enabledAt(),
                recoveryCodes.countRemaining(principal.userId()));
    }

    @Transactional
    public TwoFactorRecoveryCodesView regenerateRecoveryCodes(Principal principal,
                                                              String password,
                                                              String clientIp) {
        rateLimit.checkTwoFactor(principal.userId().toString(), clientIp);
        tenantContext.activate(principal.withWorkspace(null));
        User user = users.findById(principal.userId())
                .orElseThrow(() -> DomainException.notFound("User not found"));
        requireEnabled(principal.userId());
        reauth.requirePassword(user.id(), user.email(), password);

        List<String> codes = RecoveryCodes.newCodes();
        Instant now = clock.now();
        recoveryCodes.replaceAll(principal.userId(), codes.stream()
                .map(code -> RecoveryCodes.hash(principal.userId(), code))
                .toList(), now);
        audit.append(new AuditRecord(null, principal.userId(), ACTION_RECOVERY_REGENERATED,
                "user", principal.userId(), principal.requestId(),
                Map.of("count", codes.size()), now));
        return new TwoFactorRecoveryCodesView(codes, codes.size());
    }

    @Transactional
    public void disable(Principal principal, String password, String code, String clientIp) {
        rateLimit.checkTwoFactor(principal.userId().toString(), clientIp);
        tenantContext.activate(principal.withWorkspace(null));
        User user = users.findById(principal.userId())
                .orElseThrow(() -> DomainException.notFound("User not found"));
        TwoFactorSettings current = requireEnabled(principal.userId());
        reauth.requirePassword(user.id(), user.email(), password);

        if (!acceptCode(principal.userId(), current, code)) {
            throw invalidSecondFactor(code);
        }
        twoFactor.delete(principal.userId());
        recoveryCodes.deleteAll(principal.userId());
        audit.append(new AuditRecord(null, principal.userId(), ACTION_DISABLED, "user",
                principal.userId(), principal.requestId(), Map.of(), clock.now()));
    }

    /**
     * Login path: whether the deterministic local user has an enabled authenticator. The
     * caller has no JWT yet, so the self-scoped RLS context is activated explicitly.
     */
    @Transactional(readOnly = true)
    public Optional<TwoFactorSettings> findEnabled(UUID localUserId, String requestId) {
        tenantContext.activate(new Principal(localUserId, null, null, requestId));
        return twoFactor.find(localUserId).filter(TwoFactorSettings::isEnabled);
    }

    /**
     * Creates a single-use login challenge holding the Keycloak token pair. The pair is
     * not returned before the second factor is accepted.
     */
    public TwoFactorChallengeView challenge(UUID localUserId,
                                            ru.krug.backend.auth.application.model.KeycloakIdentity
                                                    identity,
                                            ru.krug.backend.auth.application.model.TokenSet tokens) {
        long ttlSeconds = Math.max(1, settings.twoFactorChallengeTtl().toSeconds());
        Instant expiresAt = clock.now().plusSeconds(ttlSeconds);
        UUID challengeId = challenges.store(localUserId, identity, tokens, expiresAt);
        return new TwoFactorChallengeView(challengeId, ttlSeconds,
                List.of("TOTP", "RECOVERY_CODE"));
    }

    @Transactional
    public AuthSessionView verifyChallenge(UUID challengeId, String code, String clientIp,
                                           String requestId) {
        rateLimit.checkTwoFactor(challengeId == null ? "unknown" : challengeId.toString(),
                clientIp);
        TwoFactorChallengePort.Challenge challenge = challenges.find(challengeId)
                .orElseThrow(() -> DomainException.unauthorized(
                        ErrorCode.TWO_FACTOR_CHALLENGE_INVALID,
                        "The two-factor challenge is invalid or expired", Map.of()));
        tenantContext.activate(new Principal(challenge.userId(), null, null, requestId));
        TwoFactorSettings current = twoFactor.find(challenge.userId())
                .filter(TwoFactorSettings::isEnabled)
                .orElseThrow(() -> {
                    challenges.discard(challengeId);
                    return DomainException.conflict(ErrorCode.TWO_FACTOR_NOT_ENABLED,
                            "Two-factor authentication is not enabled", Map.of());
                });
        if (!acceptCode(challenge.userId(), current, code)) {
            challenges.recordFailure(challengeId);
            throw invalidSecondFactor(code);
        }
        challenges.consume(challengeId);
        audit.append(new AuditRecord(null, challenge.userId(), ACTION_LOGIN_VERIFIED, "user",
                challenge.userId(), requestId, Map.of(), clock.now()));
        return sessions.session(challenge.identity(), challenge.tokens(), requestId);
    }

    /**
     * Accepts a current TOTP step or a one-time recovery code. A TOTP step is persisted so
     * the same 6-digit value cannot be replayed; a recovery code is consumed by the
     * database compare-and-set.
     */
    private boolean acceptCode(UUID userId, TwoFactorSettings current, String code) {
        long step = TotpCode.matchedStep(current.secret(), code, epochSecond(),
                settings.twoFactorWindow());
        if (step >= 0 && step > current.lastUsedStep()) {
            twoFactor.updateLastUsedStep(userId, step, clock.now());
            return true;
        }
        if (RecoveryCodes.isWellFormed(code)) {
            return recoveryCodes.consume(userId, RecoveryCodes.hash(userId, code), clock.now());
        }
        return false;
    }

    private TwoFactorSettings requireEnabled(UUID userId) {
        return twoFactor.find(userId)
                .filter(TwoFactorSettings::isEnabled)
                .orElseThrow(() -> DomainException.conflict(ErrorCode.TWO_FACTOR_NOT_ENABLED,
                        "Two-factor authentication is not enabled", Map.of()));
    }

    private static DomainException invalidSecondFactor(String code) {
        String errorCode = code != null && code.matches("[0-9]{6}")
                ? ErrorCode.TWO_FACTOR_CODE_INVALID
                : ErrorCode.TWO_FACTOR_RECOVERY_CODE_INVALID;
        return DomainException.unprocessable(errorCode,
                "The two-factor code is invalid", Map.of("field", "code"));
    }

    private String otpauthUri(String email, String secret) {
        String issuer = settings.twoFactorIssuer() == null || settings.twoFactorIssuer().isBlank()
                ? PROVIDER_LABEL : settings.twoFactorIssuer().strip();
        String label = encode(issuer) + ":" + encode(email);
        return "otpauth://totp/" + label
                + "?secret=" + secret
                + "&issuer=" + encode(issuer)
                + "&algorithm=SHA1&digits=6&period=30";
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }

    private static String newSecret() {
        byte[] bytes = new byte[SECRET_BYTES];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private long epochSecond() {
        return clock.now().getEpochSecond();
    }
}
