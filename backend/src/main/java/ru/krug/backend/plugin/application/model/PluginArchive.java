package ru.krug.backend.plugin.application.model;

import java.util.List;

import ru.krug.backend.plugin.domain.model.PluginAsset;
import ru.krug.backend.plugin.domain.model.PluginManifest;

/**
 * Result of safely reading one uploaded ZIP: a validated manifest plus the bounded set of
 * static files. No archive member is ever extracted to disk and no code is loaded.
 */
public record PluginArchive(
        PluginManifest manifest,
        List<PluginAsset> assets,
        String archiveSha256,
        long archiveSizeBytes,
        long unpackedSizeBytes,
        int fileCount) {

    public PluginArchive {
        assets = List.copyOf(assets);
    }
}
