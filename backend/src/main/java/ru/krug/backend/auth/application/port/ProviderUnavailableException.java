package ru.krug.backend.auth.application.port;

/** Keycloak is unreachable or returned a 5xx; retry with {@code Retry-After}. */
public class ProviderUnavailableException extends RuntimeException {

    public ProviderUnavailableException() {
        super("Identity provider is unavailable", null, false, false);
    }
}
