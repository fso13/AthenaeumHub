package ru.krug.backend.plugin.domain.repository;

import java.util.List;
import java.util.Optional;

import ru.krug.backend.plugin.domain.model.PluginPackageObject;

/** Metadata of package assets stored in S3/MinIO. */
public interface PluginPackageObjectRepository {

    void saveAll(List<PluginPackageObject> objects);

    Optional<PluginPackageObject> find(String pluginId, String path);

    List<PluginPackageObject> findByPluginId(String pluginId);
}
