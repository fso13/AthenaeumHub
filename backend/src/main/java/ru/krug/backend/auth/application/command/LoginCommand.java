package ru.krug.backend.auth.application.command;

/** {@code POST /auth/login}. The password is only forwarded to Keycloak. */
public record LoginCommand(String email, String password) {
}
