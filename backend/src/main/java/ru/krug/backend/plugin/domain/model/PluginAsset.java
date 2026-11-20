package ru.krug.backend.plugin.domain.model;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Objects;

/**
 * One static file extracted from a validated package. Bytes live only in memory while the
 * install request runs and are then written to object storage; the server filesystem is
 * never touched.
 */
public record PluginAsset(String path, String contentType, byte[] content, String sha256) {

    public static final int MAX_ASSET_BYTES = 10 * 1024 * 1024;

    public PluginAsset {
        path = PluginPaths.requireAssetPath(path, "asset path");
        Objects.requireNonNull(content, "content");
        if (content.length > MAX_ASSET_BYTES) {
            throw new IllegalArgumentException("asset is too large");
        }
        contentType = PluginContentTypes.forPath(path);
        if (sha256 == null) {
            sha256 = sha256(content);
        }
        if (!sha256.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("asset digest is invalid");
        }
    }

    @Override
    public byte[] content() {
        return content.clone();
    }

    public int size() {
        return content.length;
    }

    public static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException(ex);
        }
    }
}
