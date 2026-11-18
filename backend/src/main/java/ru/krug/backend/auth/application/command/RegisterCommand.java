package ru.krug.backend.auth.application.command;

/** {@code POST /auth/register}. The password is only forwarded to Keycloak. */
public record RegisterCommand(String email, String displayName, String password) {
}
