package ru.krug.backend.auth.application.port;

/** Keycloak rejected the grant (invalid credentials, disabled user, bad refresh token). */
public class InvalidGrantException extends RuntimeException {

    public InvalidGrantException() {
        super("Identity provider rejected the grant", null, false, false);
    }
}
