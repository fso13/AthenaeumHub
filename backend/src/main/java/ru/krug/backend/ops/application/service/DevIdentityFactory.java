package ru.krug.backend.ops.application.service;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Locale;
import java.util.UUID;

import org.springframework.stereotype.Component;

/**
 * Deterministic dev ids: repeated POST /dev/session with the same display_name reuses the
 * same user/workspace/chat/device instead of creating duplicate tenancy on every reload.
 */
@Component
public class DevIdentityFactory {

    private static final String NAMESPACE = "krug-dev-b01|";

    public String devKey(String displayName) {
        return displayName.strip().toLowerCase(Locale.ROOT);
    }

    public String emailFor(String devKey) {
        return "dev+" + hex(devKey).substring(0, 24) + "@krug.local";
    }

    public String slugFor(String devKey) {
        return "dev-" + hex(devKey).substring(0, 20);
    }

    public UUID id(String kind, String devKey) {
        byte[] digest = sha256(NAMESPACE + kind + "|" + devKey);
        digest[6] = (byte) ((digest[6] & 0x0f) | 0x50);
        digest[8] = (byte) ((digest[8] & 0x3f) | 0x80);
        ByteBuffer buffer = ByteBuffer.wrap(digest);
        return new UUID(buffer.getLong(), buffer.getLong());
    }

    private static String hex(String value) {
        return HexFormat.of().formatHex(sha256(value));
    }

    private static byte[] sha256(String value) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException(ex);
        }
    }
}
