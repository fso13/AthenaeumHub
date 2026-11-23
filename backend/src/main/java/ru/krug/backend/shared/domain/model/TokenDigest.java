package ru.krug.backend.shared.domain.model;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.regex.Pattern;

/**
 * Opaque bearer-token helpers shared by the workspace invite and auth registration flows.
 * The raw token is never persisted: only its SHA-256 hex digest may cross a repository
 * boundary. Pure Java so it is usable from every domain/application layer.
 */
public final class TokenDigest {

    /** Base64url secret shape used by workspace/channel invite tokens. */
    public static final Pattern FORMAT = Pattern.compile("^[A-Za-z0-9_-]{20,128}$");

    private TokenDigest() {
    }

    public static boolean isWellFormed(String token) {
        return token != null && FORMAT.matcher(token).matches();
    }

    public static String sha256Hex(String value) {
        if (value == null) {
            throw new IllegalArgumentException("value is required");
        }
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException("SHA-256 is not available", ex);
        }
    }
}
