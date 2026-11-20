package ru.krug.backend.plugin.application.model;

import java.time.Instant;
import java.util.List;

/** Admin read model of one installed external package. */
public record PluginPackageView(
        String id,
        String name,
        String version,
        String description,
        String author,
        String entry,
        List<String> permissions,
        List<String> modes,
        long sizeBytes,
        int fileCount,
        String sha256,
        Instant installedAt) {

    public PluginPackageView {
        permissions = permissions == null ? List.of() : List.copyOf(permissions);
        modes = modes == null ? List.of() : List.copyOf(modes);
    }
}
