package ru.krug.backend.auth.application.model;

import java.util.List;
import java.util.UUID;

/**
 * Login challenge returned instead of a session when the account has an enabled
 * authenticator. The challenge id is opaque and single-use; no token is included.
 */
public record TwoFactorChallengeView(UUID challengeId, long expiresIn, List<String> methods) {
}
