package ru.krug.backend.plugin.api.dto;

import java.time.Instant;
import java.util.List;

/** One installed external package ({@code GET /admin/plugins}, install response). */
public record AdminPluginPackageResponse(
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
}
