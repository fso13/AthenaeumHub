package ru.krug.backend.plugin.domain.repository;

import java.util.List;
import java.util.Optional;

import ru.krug.backend.plugin.domain.model.Plugin;

/**
 * Read-only port over the global built-in catalog. There is deliberately no install,
 * version, signature or arbitrary-marketplace operation in this slice.
 */
public interface PluginCatalogRepository {

    /** All built-in rows in stable display order ({@code sort_order, id}). */
    List<Plugin> findAll();

    Optional<Plugin> findById(String pluginId);
}
