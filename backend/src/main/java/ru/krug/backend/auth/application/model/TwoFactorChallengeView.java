package ru.krug.backend.auth.application.model;

import java.util.List;
import java.util.UUID;

/**
 * Login challenge returned instead of a session. The challenge id is opaque and
 * single-use; no token is included.
 *
 * <p>{@code mode} is {@link TwoFactorChallengeMode#TOTP} for an account with a confirmed
 * authenticator and {@link TwoFactorChallengeMode#ENROLL} when the installation-wide 2FA
 * policy requires the account to enroll first (#91).</p>
 */
public record TwoFactorChallengeView(UUID challengeId, long expiresIn, List<String> methods,
                                     TwoFactorChallengeMode mode) {

    public TwoFactorChallengeView {
        methods = methods == null ? List.of() : List.copyOf(methods);
    }
}
