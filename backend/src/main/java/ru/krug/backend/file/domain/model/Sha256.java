package ru.krug.backend.file.domain.model;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

import ru.krug.backend.shared.error.DomainException;

/**
 * Lowercase hex SHA-256. Hashing lives in the domain because both chunk and whole-file
 * integrity checks use the same canonical representation.
 */
public record Sha256(String value) {

    private static final Pattern HEX = Pattern.compile("^[a-f0-9]{64}$");

    public Sha256 {
        if (value == null || !HEX.matcher(value).matches()) {
            throw DomainException.badRequest("sha256 must be 64 lowercase hex characters",
                    Map.of("field", "sha256"));
        }
    }

    public static Sha256 of(String value) {
        return new Sha256(value == null ? null : value.trim().toLowerCase(Locale.ROOT));
    }

    public static boolean isValid(String value) {
        return value != null && HEX.matcher(value).matches();
    }

    public static Sha256 ofBytes(byte[] bytes) {
        try {
            return new Sha256(HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(bytes)));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException("SHA-256 is unavailable", ex);
        }
    }

    public static Sha256 ofUtf8(String value) {
        return ofBytes(value.getBytes(StandardCharsets.UTF_8));
    }

    public boolean matches(Sha256 other) {
        return other != null && value.equals(other.value);
    }
}
