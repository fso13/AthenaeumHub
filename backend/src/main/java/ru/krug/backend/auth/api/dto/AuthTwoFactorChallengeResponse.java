package ru.krug.backend.auth.api.dto;

import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * {@code 202} login challenge. {@code mode=TOTP} means the account has an enabled
 * authenticator; {@code mode=ENROLL} means the installation requires 2FA and the account
 * must create one through {@code /auth/2fa/enroll/start|verify} (#91).
 */
public record AuthTwoFactorChallengeResponse(
        @JsonProperty("challenge_id") UUID challengeId,
        @JsonProperty("expires_in") long expiresIn,
        List<String> methods,
        String mode) {
}
