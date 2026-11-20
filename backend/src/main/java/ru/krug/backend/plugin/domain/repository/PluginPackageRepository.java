package ru.krug.backend.plugin.domain.repository;

import java.util.List;
import java.util.Optional;

import ru.krug.backend.plugin.domain.model.PluginPackage;

/** Installed external package metadata. Assets are stored separately in object storage. */
public interface PluginPackageRepository {

    List<PluginPackage> findAll();

    Optional<PluginPackage> findByPluginId(String pluginId);

    void save(PluginPackage pluginPackage);

    void delete(String pluginId);
}
