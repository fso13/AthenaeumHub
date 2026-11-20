package ru.krug.backend.plugin.domain.model;

import java.util.Objects;

/** Metadata of one asset stored in S3/MinIO. The object key is opaque, never a path. */
public record PluginPackageObject(
        String pluginId,
        String path,
        String objectKey,
        String contentType,
        long sizeBytes,
        String sha256) {

    public PluginPackageObject {
        Objects.requireNonNull(pluginId, "pluginId");
        path = PluginPaths.requireAssetPath(path, "asset path");
        Objects.requireNonNull(objectKey, "objectKey");
        // S3 keys are opaque and generated from a validated package id/version/path;
        // only the S3-compatible 1024-byte limit matters here.
        if (objectKey.isBlank() || objectKey.length() > 1024) {
            throw new IllegalArgumentException("object key is invalid");
        }
        contentType = PluginContentTypes.forPath(path);
        if (sizeBytes < 0 || sizeBytes > PluginAsset.MAX_ASSET_BYTES) {
            throw new IllegalArgumentException("asset size is outside the allowed range");
        }
        if (sha256 == null || !sha256.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("asset digest is invalid");
        }
    }
}
