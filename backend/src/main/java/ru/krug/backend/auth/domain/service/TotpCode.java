package ru.krug.backend.auth.domain.service;

import java.nio.ByteBuffer;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Locale;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * RFC 6238 TOTP, SHA-1, 6 decimal digits, 30-second step. The verifier accepts a
 * configurable number of adjacent steps (Auth BFF: ±5 → five minutes).
 *
 * <p>Pure Java; no Spring, no persistence. Codes are compared in constant time and are
 * never logged.</p>
 */
public final class TotpCode {

    public static final int DIGITS = 6;
    public static final int STEP_SECONDS = 30;
    private static final int MODULUS = 1_000_000;
    private static final String HMAC = "HmacSHA1";

    private TotpCode() {
    }

    public static String generate(String base64Secret, long epochSecond) {
        if (base64Secret == null || base64Secret.isBlank()) {
            throw new IllegalArgumentException("TOTP secret is required");
        }
        byte[] key;
        try {
            key = Base64.getUrlDecoder().decode(base64Secret);
        } catch (IllegalArgumentException ex) {
            throw new IllegalArgumentException("TOTP secret is not base64url");
        }
        return format(hotp(key, epochSecond / STEP_SECONDS));
    }

    public static boolean matches(String base64Secret, String code, long epochSecond,
                                  int window) {
        return matchedStep(base64Secret, code, epochSecond, window) >= 0;
    }

    /**
     * Time step of the accepted code, or {@code -1}. The caller persists the step so the
     * same TOTP code cannot be replayed inside its validity window (RFC 6238 §5.2).
     */
    public static long matchedStep(String base64Secret, String code, long epochSecond,
                                   int window) {
        if (code == null || !code.matches("[0-9]{6}")) {
            return -1L;
        }
        long counter = epochSecond / STEP_SECONDS;
        byte[] expected = code.getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        for (int offset = -window; offset <= window; offset++) {
            long candidateStep = counter + offset;
            String candidate = generate(base64Secret, candidateStep * STEP_SECONDS);
            if (MessageDigest.isEqual(expected,
                    candidate.getBytes(java.nio.charset.StandardCharsets.US_ASCII))) {
                return candidateStep;
            }
        }
        return -1L;
    }

    public static boolean isWellFormed(String code) {
        return code != null && code.matches("[0-9]{6}");
    }

    private static String format(int value) {
        return String.format(Locale.ROOT, "%0" + DIGITS + "d", value);
    }

    private static int hotp(byte[] key, long counter) {
        try {
            Mac mac = Mac.getInstance(HMAC);
            mac.init(new SecretKeySpec(key, HMAC));
            byte[] hash = mac.doFinal(ByteBuffer.allocate(8).putLong(counter).array());
            int offset = hash[hash.length - 1] & 0x0f;
            int binary = ((hash[offset] & 0x7f) << 24)
                    | ((hash[offset + 1] & 0xff) << 16)
                    | ((hash[offset + 2] & 0xff) << 8)
                    | (hash[offset + 3] & 0xff);
            return binary % MODULUS;
        } catch (GeneralSecurityException ex) {
            throw new IllegalStateException("HMAC-SHA1 is unavailable", ex);
        }
    }
}
