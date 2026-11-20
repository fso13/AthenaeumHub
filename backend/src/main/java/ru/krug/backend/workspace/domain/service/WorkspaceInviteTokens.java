package ru.krug.backend.workspace.domain.service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HexFormat;
import java.util.regex.Pattern;

/**
 * Opaque workspace invite tokens (P0-4 / #82). A 32-byte base64url secret is returned
 * exactly once; only the SHA-256 hex digest is persisted.
 */
public final class WorkspaceInviteTokens {

    public static final int TOKEN_BYTES = 32;
    public static final Pattern FORMAT = Pattern.compile("^[A-Za-z0-9_-]{20,128}$");

    private static final SecureRandom RANDOM = new SecureRandom();

    private WorkspaceInviteTokens() {
    }

    public static String newToken() {
        byte[] bytes = new byte[TOKEN_BYTES];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    public static boolean isWellFormed(String token) {
        return token != null && FORMAT.matcher(token).matches();
    }

    public static String hash(String token) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(token.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException("SHA-256 is not available", ex);
        }
    }
}
