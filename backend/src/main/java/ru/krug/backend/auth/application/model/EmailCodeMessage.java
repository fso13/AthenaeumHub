package ru.krug.backend.auth.application.model;

/** Rendering model for the verification email. The code lives only in memory here. */
public record EmailCodeMessage(String email, String displayName, String code,
                               int expiresInMinutes) {
}
