package ru.krug.backend.plugin.application.port;

import ru.krug.backend.plugin.application.model.PluginArchive;

/**
 * Reads an uploaded ZIP into a validated manifest and bounded static assets. Implementations
 * must reject traversal, symlinks, encrypted members, duplicate paths, zip bombs and
 * archives above the documented limits. The server filesystem is never used.
 */
public interface PluginPackageArchivePort {

    PluginArchive read(byte[] archiveBytes);
}
