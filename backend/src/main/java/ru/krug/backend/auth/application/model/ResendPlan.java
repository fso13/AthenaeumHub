package ru.krug.backend.auth.application.model;

import java.util.UUID;

/** Internal result of preparing a resend; the email is sent after the transaction commits. */
public record ResendPlan(UUID verificationId, String email, String displayName, String code,
                         long expiresIn, long resendAfter) {
}
