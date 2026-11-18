package ru.krug.backend.auth.application.service;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;
import java.util.UUID;

import org.springframework.stereotype.Component;

import ru.krug.backend.auth.application.model.KeycloakIdentity;

/**
 * Deterministic local identities for JIT provisioning. Deriving the local user id from
 * (provider, subject) makes concurrent first requests converge on the same row instead of
 * creating duplicate users.
 */
@Component
public class KeycloakIdentityFactory {

    private static final String NAMESPACE = "krug-oidc|";
    private static final int MAX_DISPLAY_NAME = 80;

    public UUID localUserId(String subject) {
        byte[] digest = sha256(NAMESPACE + "user|" + subject);
        digest[6] = (byte) ((digest[6] & 0x0f) | 0x50);
        digest[8] = (byte) ((digest[8] & 0x3f) | 0x80);
        ByteBuffer buffer = ByteBuffer.wrap(digest);
        return new UUID(buffer.getLong(), buffer.getLong());
    }

    /**
     * Keycloak email when present; otherwise preferred_username, as required by
     * AUTH-D-03. A username that is not an email gets a stable local domain so the
     * contract's {@code format: email} still holds.
     */
    public String email(KeycloakIdentity identity) {
        String email = identity.email() == null ? null : identity.email().strip();
        if (isEmail(email)) {
            return email.toLowerCase(Locale.ROOT);
        }
        String preferredUsername = identity.preferredUsername() == null
                ? null : identity.preferredUsername().strip();
        if (isEmail(preferredUsername)) {
            return preferredUsername.toLowerCase(Locale.ROOT);
        }
        String username = sanitizeUsername(preferredUsername);
        return username + "@keycloak.local";
    }

    /** Second attempt after an email uniqueness conflict: add a stable sub-based suffix. */
    public String collisionEmail(KeycloakIdentity identity) {
        String username = sanitizeUsername(identity.preferredUsername());
        String suffix = hex(sha256(NAMESPACE + "email|" + identity.subject())).substring(0, 10);
        return username + "." + suffix + "@keycloak.local";
    }

    public String displayName(KeycloakIdentity identity) {
        String candidate = identity.displayName();
        if (isBlank(candidate)) {
            candidate = identity.preferredUsername();
        }
        if (isBlank(candidate)) {
            candidate = "Пользователь";
        }
        String normalized = candidate.strip();
        if (normalized.length() > MAX_DISPLAY_NAME) {
            normalized = normalized.substring(0, MAX_DISPLAY_NAME).strip();
        }
        return normalized;
    }

    public static boolean isEmail(String value) {
        if (value == null || value.length() < 3 || value.length() > 254) {
            return false;
        }
        int at = value.indexOf('@');
        return at > 0 && at == value.lastIndexOf('@') && at < value.length() - 1
                && value.chars().noneMatch(Character::isWhitespace);
    }

    private static String sanitizeUsername(String username) {
        String value = username == null ? "" : username.strip().toLowerCase(Locale.ROOT);
        value = value.replaceAll("[^a-z0-9._-]", "-");
        if (value.isBlank()) {
            return "user";
        }
        return value.length() > 64 ? value.substring(0, 64) : value;
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    private static String hex(byte[] bytes) {
        StringBuilder builder = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            builder.append(Character.forDigit((b >> 4) & 0xf, 16));
            builder.append(Character.forDigit(b & 0xf, 16));
        }
        return builder.toString();
    }

    private static byte[] sha256(String value) {
        try {
            return MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException(ex);
        }
    }
}
