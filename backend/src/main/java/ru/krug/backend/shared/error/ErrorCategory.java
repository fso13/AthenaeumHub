package ru.krug.backend.shared.error;

/**
 * Transport-neutral error category. The API layer maps it to an HTTP status; domain and
 * application code never know about HTTP.
 */
public enum ErrorCategory {
    BAD_REQUEST,
    UNPROCESSABLE,
    UNAUTHORIZED,
    FORBIDDEN,
    NOT_FOUND,
    GONE,
    CONFLICT,
    LOCKED,
    PAYLOAD_TOO_LARGE,
    UNSUPPORTED_MEDIA_TYPE,
    RATE_LIMITED,
    SERVICE_UNAVAILABLE,
    INTERNAL
}
