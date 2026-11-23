package ru.krug.backend.workspace.domain.service;

import java.security.SecureRandom;
import java.util.Base64;

import ru.krug.backend.shared.domain.model.TokenDigest;

/**
 * Opaque workspace invite tokens (P0-4 / #82). A 32-byte base64url secret is returned
 * exactly once; only the SHA-256 hex digest is persisted.
 */
public final class WorkspaceInviteTokens {

    public static final int TOKEN_BYTES = 32;

    private static final SecureRandom RANDOM = new SecureRandom();

    private WorkspaceInviteTokens() {
    }

    public static String newToken() {
        byte[] bytes = new byte[TOKEN_BYTES];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    public static boolean isWellFormed(String token) {
        return TokenDigest.isWellFormed(token);
    }

    public static String hash(String token) {
        return TokenDigest.sha256Hex(token);
    }
}
