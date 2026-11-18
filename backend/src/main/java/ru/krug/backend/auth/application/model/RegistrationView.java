package ru.krug.backend.auth.application.model;

import java.util.UUID;

/** 202 body of {@code POST /auth/register}. */
public record RegistrationView(UUID verificationId, long expiresIn, long resendAfter) {
}
