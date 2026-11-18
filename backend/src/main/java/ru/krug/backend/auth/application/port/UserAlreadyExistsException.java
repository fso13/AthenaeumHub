package ru.krug.backend.auth.application.port;

/** Keycloak already has a user with this username/email. */
public class UserAlreadyExistsException extends RuntimeException {

    public UserAlreadyExistsException() {
        super("Identity provider user already exists", null, false, false);
    }
}
