package ru.krug.backend.bot.application.service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * One-time response capability format:
 * {@code sova_resp_<workspace-uuid>_<token-uuid>_<32 random bytes base64url>}.
 *
 * <p>The workspace/token ids are not secrets; they let the endpoint activate the tenant RLS
 * context and locate the row before the constant-time hash comparison. The secret is the
 * last segment; only {@code SHA-256(raw)} is stored.</p>
 */
public final class BotResponseTokens {

    public static final String PREFIX = "sova_resp_";
    private static final Pattern PATTERN = Pattern.compile(
            "^sova_resp_([0-9a-fA-F-]{36})_([0-9a-fA-F-]{36})_([A-Za-z0-9_-]{43})$");
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final int SECRET_BYTES = 32;

    private BotResponseTokens() {
    }

    public static String newRawToken(UUID workspaceId, UUID tokenId) {
        byte[] secret = new byte[SECRET_BYTES];
        RANDOM.nextBytes(secret);
        return PREFIX + workspaceId + "_" + tokenId + "_"
                + Base64.getUrlEncoder().withoutPadding().encodeToString(secret);
    }

    public static byte[] hash(String rawToken) {
        try {
            return MessageDigest.getInstance("SHA-256")
                    .digest(rawToken.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException("SHA-256 is not available", ex);
        }
    }

    public static Optional<Parsed> parse(String rawToken) {
        if (rawToken == null) {
            return Optional.empty();
        }
        Matcher matcher = PATTERN.matcher(rawToken);
        if (!matcher.matches()) {
            return Optional.empty();
        }
        try {
            return Optional.of(new Parsed(UUID.fromString(matcher.group(1)),
                    UUID.fromString(matcher.group(2))));
        } catch (IllegalArgumentException ex) {
            return Optional.empty();
        }
    }

    public static final class Parsed {

        private final UUID workspaceId;
        private final UUID tokenId;

        private Parsed(UUID workspaceId, UUID tokenId) {
            this.workspaceId = workspaceId;
            this.tokenId = tokenId;
        }

        public UUID workspaceId() {
            return workspaceId;
        }

        public UUID tokenId() {
            return tokenId;
        }

        @Override
        public String toString() {
            return "Parsed[workspaceId=" + workspaceId + ", tokenId=" + tokenId + "]";
        }
    }
}
