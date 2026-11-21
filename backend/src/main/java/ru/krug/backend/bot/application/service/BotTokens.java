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
 * One-time token format and hashing for bots.
 *
 * <p>Format: {@code sova_bot_<workspace-uuid>_<bot-uuid>_<32 random bytes base64url>}. The
 * workspace/bot ids are not secrets; they let the authentication filter activate the tenant
 * RLS context before reading the bot row. Only {@code SHA-256(raw token)} is stored.</p>
 *
 * <p>The raw token is never logged: {@link Parsed#toString()} redacts the secret.</p>
 */
public final class BotTokens {

    public static final String PREFIX = "sova_bot_";
    private static final Pattern PATTERN = Pattern.compile(
            "^sova_bot_([0-9a-fA-F-]{36})_([0-9a-fA-F-]{36})_([A-Za-z0-9_-]{43})$");
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final int SECRET_BYTES = 32;

    private BotTokens() {
    }

    public static String newRawToken(UUID workspaceId, UUID botId) {
        byte[] secret = new byte[SECRET_BYTES];
        RANDOM.nextBytes(secret);
        return PREFIX + workspaceId + "_" + botId + "_"
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

    /** Parses the non-secret ids and keeps the raw token only for the hash comparison. */
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

    /** Non-secret identity carried by a structurally valid token. */
    public static final class Parsed {

        private final UUID workspaceId;
        private final UUID botId;

        private Parsed(UUID workspaceId, UUID botId) {
            this.workspaceId = workspaceId;
            this.botId = botId;
        }

        public UUID workspaceId() {
            return workspaceId;
        }

        public UUID botId() {
            return botId;
        }

        @Override
        public String toString() {
            return "Parsed[workspaceId=" + workspaceId + ", botId=" + botId + "]";
        }
    }
}
