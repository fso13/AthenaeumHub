package ru.krug.backend.auth.application.command;

/**
 * PATCH /me semantics: a field is changed only when it is present in the JSON body.
 * Present-and-null clears {@code bio}/{@code phone}; a null/blank {@code display_name}
 * is rejected by the domain value object. Email and password are not representable here.
 */
public record UpdateProfileCommand(
        boolean displayNamePresent,
        String displayName,
        boolean bioPresent,
        String bio,
        boolean phonePresent,
        String phone) {

    public boolean isEmpty() {
        return !displayNamePresent && !bioPresent && !phonePresent;
    }
}
