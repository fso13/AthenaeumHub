package ru.krug.backend.auth.application.model;

/** 202 body of {@code POST /auth/resend-email-code}. */
public record ResendCodeView(long expiresIn, long resendAfter) {
}
