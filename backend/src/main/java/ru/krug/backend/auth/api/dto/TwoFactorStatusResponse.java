package ru.krug.backend.auth.api.dto;

import java.time.Instant;

import com.fasterxml.jackson.annotation.JsonProperty;

/** Authenticator state; no secret or code is ever returned. */
public record TwoFactorStatusResponse(boolean enabled,
                                      @JsonProperty("enabled_at") Instant enabledAt,
                                      @JsonProperty("recovery_codes_remaining")
                                      long recoveryCodesRemaining) {
}
