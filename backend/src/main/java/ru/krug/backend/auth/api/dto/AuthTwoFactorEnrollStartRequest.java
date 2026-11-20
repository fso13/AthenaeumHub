package ru.krug.backend.auth.api.dto;

import java.util.UUID;

import jakarta.validation.constraints.NotNull;

/** {@code POST /auth/2fa/enroll/start}: the ENROLL challenge from {@code POST /auth/login}. */
public record AuthTwoFactorEnrollStartRequest(@NotNull UUID challengeId) {
}
