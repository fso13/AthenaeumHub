package ru.krug.backend.auth.application.usecase;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCategory;
import ru.krug.backend.shared.error.ErrorCode;

/** Shared Auth BFF error mapping (transport-neutral DomainException codes). */
final class AuthBffErrors {

    private AuthBffErrors() {
    }

    static DomainException invalidCredentials() {
        return DomainException.unauthorized(ErrorCode.INVALID_CREDENTIALS,
                "Invalid email or password", Map.of());
    }

    static DomainException emailNotVerified(UUID verificationId) {
        Map<String, Object> details = new LinkedHashMap<>();
        if (verificationId != null) {
            details.put("verification_id", verificationId.toString());
        }
        return new DomainException(ErrorCategory.FORBIDDEN, ErrorCode.EMAIL_NOT_VERIFIED,
                "Email is not verified", details, null);
    }

    static DomainException accountSuspended() {
        return new DomainException(ErrorCategory.FORBIDDEN, ErrorCode.ACCOUNT_SUSPENDED,
                "Account is suspended", Map.of(), null);
    }

    static DomainException codeInvalid(int attemptsLeft) {
        return DomainException.unprocessable(ErrorCode.CODE_INVALID,
                "Verification code is invalid", Map.of("attempts_left", Math.max(0, attemptsLeft)));
    }

    static DomainException codeExpired() {
        return DomainException.gone(ErrorCode.CODE_EXPIRED,
                "Verification code is expired or already used", Map.of());
    }

    static DomainException emailTaken() {
        return DomainException.conflict(ErrorCode.EMAIL_TAKEN, "Email is already registered",
                Map.of("field", "email"));
    }

    static DomainException registrationClosed() {
        return new DomainException(ErrorCategory.FORBIDDEN, ErrorCode.REGISTRATION_CLOSED,
                "Registration is closed", Map.of(), null);
    }

    static DomainException verificationNotFound() {
        return DomainException.notFound("Email verification was not found");
    }

    static DomainException verificationLocked(int maxAttempts, long retryAfterSeconds) {
        return DomainException.rateLimited(Math.max(1, retryAfterSeconds), Map.of(
                "scope", "verification",
                "max_attempts", maxAttempts));
    }

    static DomainException authUnavailable(String reason) {
        return DomainException.serviceUnavailable(ErrorCode.AUTH_UNAVAILABLE,
                "Authentication service is unavailable", Map.of("reason", reason), 5L);
    }

    static DomainException twoFactorRequired() {
        return DomainException.forbidden(ErrorCode.TWO_FACTOR_REQUIRED,
                "Two-factor authentication is required", Map.of());
    }

    static DomainException sessionExpired() {
        return DomainException.unauthorized(ErrorCode.AUTH_SESSION_EXPIRED,
                "The session has been idle for longer than the workspace allows", Map.of());
    }

    static DomainException passwordRejected() {
        return DomainException.unprocessable(ErrorCode.VALIDATION_FAILED,
                "Password does not meet the identity provider policy",
                Map.of("field", "password"));
    }
}
