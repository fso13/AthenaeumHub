package ru.krug.backend.auth.domain.service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * One-time TOTP recovery codes (P0-4 / #82). A code is 12 base32 characters in three
 * groups ({@code XXXX-XXXX-XXXX}, 60 bits of entropy). Only a SHA-256 digest bound to the
 * user id is persisted; the raw list is returned once by
 * {@code POST /me/2fa/recovery-codes} and is never recoverable.
 *
 * <p>Pure Java so the hashing/normalisation rule cannot drift between generation and
 * verification.</p>
 */
public final class RecoveryCodes {

    public static final int CODE_COUNT = 10;
    private static final char[] ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".toCharArray();
    private static final int GROUPS = 3;
    private static final int GROUP_LENGTH = 4;
    private static final int NORMALIZED_LENGTH = GROUPS * GROUP_LENGTH;
    private static final Pattern FORMAT =
            Pattern.compile("^(?:[A-Za-z2-7]{4}-[A-Za-z2-7]{4}-[A-Za-z2-7]{4}"
                    + "|[A-Za-z2-7]{12})$");
    private static final SecureRandom RANDOM = new SecureRandom();

    private RecoveryCodes() {
    }

    /** Generates a fresh list; the caller shows it once and stores only {@link #hash}. */
    public static List<String> newCodes() {
        List<String> codes = new ArrayList<>(CODE_COUNT);
        for (int index = 0; index < CODE_COUNT; index++) {
            codes.add(format(randomCode()));
        }
        return List.copyOf(codes);
    }

    public static boolean isWellFormed(String code) {
        return code != null && FORMAT.matcher(code).matches();
    }

    /** SHA-256 hex digest bound to the user id; the only representation persisted. */
    public static String hash(UUID userId, String code) {
        if (userId == null) {
            throw new IllegalArgumentException("userId is required");
        }
        String normalized = normalize(code);
        if (normalized.length() != NORMALIZED_LENGTH) {
            throw new IllegalArgumentException("Recovery code has an invalid length");
        }
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(
                    ("2fa-recovery|" + userId + "|" + normalized)
                            .getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException("SHA-256 is not available", ex);
        }
    }

    public static String normalize(String code) {
        if (code == null) {
            return "";
        }
        return code.replace("-", "").strip().toUpperCase(Locale.ROOT);
    }

    private static String randomCode() {
        char[] value = new char[NORMALIZED_LENGTH];
        for (int index = 0; index < value.length; index++) {
            value[index] = ALPHABET[RANDOM.nextInt(ALPHABET.length)];
        }
        return new String(value);
    }

    private static String format(String normalized) {
        StringBuilder builder = new StringBuilder(14);
        for (int group = 0; group < GROUPS; group++) {
            if (group > 0) {
                builder.append('-');
            }
            builder.append(normalized, group * GROUP_LENGTH, (group + 1) * GROUP_LENGTH);
        }
        return builder.toString();
    }
}
