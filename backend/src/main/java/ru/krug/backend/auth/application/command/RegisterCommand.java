package ru.krug.backend.auth.application.command;

/**
 * {@code POST /auth/register}. The password is only forwarded to Keycloak. #100: the
 * optional {@code inviteToken} is hashed immediately; only the digest is stored with the
 * pending verification row.
 */
public record RegisterCommand(String email, String displayName, String password,
                              String inviteToken) {

    public RegisterCommand(String email, String displayName, String password) {
        this(email, displayName, password, null);
    }
}
