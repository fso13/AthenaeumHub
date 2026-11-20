package ru.krug.backend.chat.domain.service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HexFormat;
import java.util.regex.Pattern;

/**
 * Opaque invite tokens (#79). The raw token is a 32-byte base64url secret returned exactly
 * once by {@code POST /chats/{chatId}/invites}; only the SHA-256 hex digest is persisted.
 *
 * <p>Pure Java by design: the domain owns token shape/hashing, so no infrastructure type
 * leaks into the application layer and the hash rule cannot drift between create/list.</p>
 */
public final class InviteTokens {

    /** 32 random bytes → 43 base64url characters without padding. */
    public static final int TOKEN_BYTES = 32;

    /** Matches the contract parameter pattern; rejects path tricks before hashing. */
    public static final Pattern FORMAT = Pattern.compile("^[A-Za-z0-9_-]{20,128}$");

    private static final SecureRandom RANDOM = new SecureRandom();

    private InviteTokens() {
    }

    public static String newToken() {
        byte[] bytes = new byte[TOKEN_BYTES];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    public static boolean isWellFormed(String token) {
        return token != null && FORMAT.matcher(token).matches();
    }

    /** SHA-256 hex digest; the only representation that reaches the database. */
    public static String hash(String token) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(token.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException("SHA-256 is not available", ex);
        }
    }
}
