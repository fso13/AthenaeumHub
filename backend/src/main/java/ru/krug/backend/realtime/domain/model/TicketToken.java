package ru.krug.backend.realtime.domain.model;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * Opaque one-time ticket secret. 32 random bytes encoded as base64url without padding
 * (43 characters). The raw value is returned to the client once and is never stored.
 */
public final class TicketToken {

    private static final int TOKEN_BYTES = 32;
    private static final Pattern TOKEN_PATTERN = Pattern.compile("[A-Za-z0-9_-]{43}");
    private static final SecureRandom RANDOM = new SecureRandom();

    private final String value;

    private TicketToken(String value) {
        this.value = value;
    }

    public static TicketToken generate() {
        byte[] bytes = new byte[TOKEN_BYTES];
        RANDOM.nextBytes(bytes);
        return new TicketToken(Base64.getUrlEncoder().withoutPadding().encodeToString(bytes));
    }

    public static TicketToken of(String raw) {
        Objects.requireNonNull(raw, "ticket");
        String trimmed = raw.strip();
        if (!TOKEN_PATTERN.matcher(trimmed).matches()) {
            throw new IllegalArgumentException("ticket must be 43 base64url characters");
        }
        return new TicketToken(trimmed);
    }

    public String value() {
        return value;
    }

    public TicketTokenHash hash() {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(value.getBytes(StandardCharsets.UTF_8));
            return new TicketTokenHash(HexFormat.of().formatHex(hash));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException("SHA-256 is required by the JVM", ex);
        }
    }
}
