package ru.krug.backend.auth.application.port;

/** The identity provider rejected the password (policy, malformed value, etc.). */
public class PasswordRejectedException extends RuntimeException {

    public PasswordRejectedException() {
        super("Identity provider rejected the password", null, false, false);
    }
}
