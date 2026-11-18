package ru.krug.backend.shared.application.model;

import java.util.Arrays;
import java.util.Base64;
import java.util.Optional;

/**
 * Canonical unpadded base64url (RFC 4648 §5) used by the E2EE wire format. Decoding is
 * strict: the alphabet, absence of padding and a canonical re-encode are all required.
 */
public final class Base64Url {

    private Base64Url() {
    }

    public static Optional<byte[]> decode(String value) {
        if (value == null || value.isEmpty() || value.indexOf('=') >= 0) {
            return Optional.empty();
        }
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                    || c == '-' || c == '_')) {
                return Optional.empty();
            }
        }
        if (value.length() % 4 == 1) {
            return Optional.empty();
        }
        try {
            byte[] decoded = Base64.getUrlDecoder().decode(value);
            if (!encode(decoded).equals(value)) {
                return Optional.empty();
            }
            return Optional.of(decoded);
        } catch (IllegalArgumentException ex) {
            return Optional.empty();
        }
    }

    public static Optional<byte[]> decode(String value, int expectedLength) {
        return decode(value).filter(bytes -> bytes.length == expectedLength);
    }

    public static String encode(byte[] value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
    }

    public static boolean sameBytes(byte[] left, byte[] right) {
        return left != null && right != null && Arrays.equals(left, right);
    }
}
