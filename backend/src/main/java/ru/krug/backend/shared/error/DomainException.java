package ru.krug.backend.shared.error;

import java.util.Map;

/**
 * Domain/application exception. Contains no transport types: the category is mapped to
 * HTTP by the API layer only. Stack traces are disabled because these are expected
 * business outcomes.
 */
public class DomainException extends RuntimeException {

    private final ErrorCategory category;
    private final String code;
    private final Map<String, Object> details;
    private final Long retryAfterSeconds;

    public DomainException(ErrorCategory category, String code, String message,
                           Map<String, Object> details, Long retryAfterSeconds) {
        super(message, null, false, false);
        this.category = category;
        this.code = code;
        this.details = details == null ? Map.of() : Map.copyOf(details);
        this.retryAfterSeconds = retryAfterSeconds;
    }

    public ErrorCategory category() {
        return category;
    }

    public String code() {
        return code;
    }

    public Map<String, Object> details() {
        return details;
    }

    public Long retryAfterSeconds() {
        return retryAfterSeconds;
    }

    public static DomainException badRequest(String message, Map<String, Object> details) {
        return new DomainException(ErrorCategory.BAD_REQUEST, ErrorCode.VALIDATION_FAILED,
                message, details, null);
    }

    public static DomainException unprocessable(String message, Map<String, Object> details) {
        return new DomainException(ErrorCategory.UNPROCESSABLE, ErrorCode.VALIDATION_FAILED,
                message, details, null);
    }

    public static DomainException unprocessable(String code, String message,
                                                Map<String, Object> details) {
        return new DomainException(ErrorCategory.UNPROCESSABLE, code, message, details, null);
    }

    public static DomainException unauthorized(String code, String message,
                                               Map<String, Object> details) {
        return new DomainException(ErrorCategory.UNAUTHORIZED, code, message, details, null);
    }

    public static DomainException gone(String code, String message, Map<String, Object> details) {
        return new DomainException(ErrorCategory.GONE, code, message, details, null);
    }

    public static DomainException serviceUnavailable(String code, String message,
                                                     Map<String, Object> details,
                                                     Long retryAfterSeconds) {
        return new DomainException(ErrorCategory.SERVICE_UNAVAILABLE, code, message, details,
                retryAfterSeconds);
    }

    public static DomainException forbidden(String message) {
        return new DomainException(ErrorCategory.FORBIDDEN, ErrorCode.FORBIDDEN, message,
                Map.of(), null);
    }

    /** Forbidden with a domain-specific code (for example {@code ROLE_CHANGE_FORBIDDEN}). */
    public static DomainException forbidden(String code, String message,
                                            Map<String, Object> details) {
        return new DomainException(ErrorCategory.FORBIDDEN, code, message, details, null);
    }

    public static DomainException notFound(String message) {
        return new DomainException(ErrorCategory.NOT_FOUND, ErrorCode.NOT_FOUND, message,
                Map.of(), null);
    }

    /** Not found with a domain-specific code (for example {@code USER_NOT_FOUND}). */
    public static DomainException notFound(String code, String message,
                                           Map<String, Object> details) {
        return new DomainException(ErrorCategory.NOT_FOUND, code, message, details, null);
    }

    public static DomainException conflict(String code, String message,
                                           Map<String, Object> details) {
        return new DomainException(ErrorCategory.CONFLICT, code, message, details, null);
    }

    public static DomainException idempotencyInProgress() {
        return new DomainException(ErrorCategory.CONFLICT, ErrorCode.IDEMPOTENCY_IN_PROGRESS,
                "The same Idempotency-Key is still being processed", Map.of(), 1L);
    }

    public static DomainException payloadTooLarge(String code, String message,
                                                  Map<String, Object> details) {
        return new DomainException(ErrorCategory.PAYLOAD_TOO_LARGE, code, message, details, null);
    }

    public static DomainException rateLimited(long retryAfterSeconds,
                                              Map<String, Object> details) {
        return new DomainException(ErrorCategory.RATE_LIMITED, ErrorCode.RATE_LIMITED,
                "Rate limit exceeded", details, retryAfterSeconds);
    }

    public static DomainException internal() {
        return new DomainException(ErrorCategory.INTERNAL, ErrorCode.INTERNAL,
                "Internal server error", Map.of(), null);
    }
}
