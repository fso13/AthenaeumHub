package ru.krug.backend.auth.application.command;

import java.util.UUID;

/** {@code POST /auth/verify-email}. */
public record VerifyEmailCommand(UUID verificationId, String code) {
}
