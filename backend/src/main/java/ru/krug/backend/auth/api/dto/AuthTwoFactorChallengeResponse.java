package ru.krug.backend.auth.api.dto;

import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonProperty;

/** {@code 202} login challenge when the account has an enabled authenticator. */
public record AuthTwoFactorChallengeResponse(
        @JsonProperty("challenge_id") UUID challengeId,
        @JsonProperty("expires_in") long expiresIn,
        List<String> methods) {
}
