package ru.krug.backend.auth.application.model;

import java.util.Objects;

/**
 * Result of {@code POST /auth/login}: either a complete session or a second-factor
 * challenge. No field is nullable in a valid outcome; the two static factories make the
 * distinction explicit at the API boundary.
 */
public record LoginOutcome(AuthSessionView session, TwoFactorChallengeView challenge) {

    public static LoginOutcome authenticated(AuthSessionView session) {
        return new LoginOutcome(Objects.requireNonNull(session, "session"), null);
    }

    public static LoginOutcome challenge(TwoFactorChallengeView challenge) {
        return new LoginOutcome(null, Objects.requireNonNull(challenge, "challenge"));
    }

    public boolean requiresSecondFactor() {
        return challenge != null;
    }
}
