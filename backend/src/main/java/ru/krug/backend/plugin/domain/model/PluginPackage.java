package ru.krug.backend.plugin.domain.model;

import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.UUID;

/**
 * Installed external package metadata. Asset bytes live in object storage; this record
 * only holds bounded metadata and digests.
 */
public record PluginPackage(
        String pluginId,
        String name,
        String version,
        String description,
        String author,
        String entry,
        List<String> permissions,
        List<PluginMode> modes,
        String archiveSha256,
        long archiveSizeBytes,
        long unpackedSizeBytes,
        int fileCount,
        UUID installedBy,
        Instant installedAt) {

    public static final long MAX_ARCHIVE_BYTES = 5L * 1024 * 1024;
    public static final long MAX_UNPACKED_BYTES = 10L * 1024 * 1024;
    public static final int MAX_FILES = 200;

    public PluginPackage {
        Objects.requireNonNull(pluginId, "pluginId");
        if (!pluginId.matches("[a-z][a-z0-9-]{0,63}")) {
            throw new IllegalArgumentException("plugin id must be a lowercase slug");
        }
        Objects.requireNonNull(name, "name");
        Objects.requireNonNull(version, "version");
        Objects.requireNonNull(description, "description");
        Objects.requireNonNull(author, "author");
        entry = PluginPaths.requireEntry(entry);
        Objects.requireNonNull(permissions, "permissions");
        Objects.requireNonNull(modes, "modes");
        if (archiveSha256 == null || !archiveSha256.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("archive digest is invalid");
        }
        if (archiveSizeBytes <= 0 || archiveSizeBytes > MAX_ARCHIVE_BYTES) {
            throw new IllegalArgumentException("archive size is outside the allowed range");
        }
        if (unpackedSizeBytes <= 0 || unpackedSizeBytes > MAX_UNPACKED_BYTES) {
            throw new IllegalArgumentException("unpacked size is outside the allowed range");
        }
        if (fileCount <= 0 || fileCount > MAX_FILES) {
            throw new IllegalArgumentException("file count is outside the allowed range");
        }
        Objects.requireNonNull(installedBy, "installedBy");
        Objects.requireNonNull(installedAt, "installedAt");
        permissions = List.copyOf(permissions);
        modes = List.copyOf(modes);
    }
}
