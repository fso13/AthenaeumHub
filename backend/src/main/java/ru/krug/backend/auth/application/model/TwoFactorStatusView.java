package ru.krug.backend.auth.application.model;

import java.time.Instant;

/** Authenticator state; never contains the secret, a code or a recovery code. */
public record TwoFactorStatusView(boolean enabled, Instant enabledAt,
                                  long recoveryCodesRemaining) {
}
