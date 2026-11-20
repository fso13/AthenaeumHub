package ru.krug.backend.plugin.domain.repository;

import java.util.List;
import java.util.Optional;

import ru.krug.backend.plugin.domain.model.Plugin;
import ru.krug.backend.plugin.domain.model.PluginManifest;

/**
 * Catalog port. Built-in rows are read-only first-party metadata. External package rows
 * are managed by the admin install/uninstall use cases; the database restricts the
 * application role's writes to {@code kind = 'EXTERNAL'}.
 */
public interface PluginCatalogRepository {

    /** All installed rows (built-in and external) in stable display order. */
    List<Plugin> findAll();

    /** Installed row by id; an uninstalled external plugin is not found. */
    Optional<Plugin> findById(String pluginId);

    /**
     * Any catalog row by id, including an uninstalled external row. Used by the install
     * flow to distinguish a reserved built-in id from a reinstall.
     */
    Optional<Plugin> findAnyById(String pluginId);

    /** Inserts or re-activates the catalog row of an external package. */
    void installExternal(PluginManifest manifest);

    /**
     * Hides an uninstalled external plugin while keeping the row (chat toggles may still
     * reference it). Built-in rows are never touched.
     */
    void markUninstalled(String pluginId);
}
