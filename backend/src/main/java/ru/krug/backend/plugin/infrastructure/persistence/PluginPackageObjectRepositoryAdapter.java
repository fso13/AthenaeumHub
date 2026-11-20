package ru.krug.backend.plugin.infrastructure.persistence;

import java.util.List;
import java.util.Optional;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.plugin.domain.model.PluginPackageObject;
import ru.krug.backend.plugin.domain.repository.PluginPackageObjectRepository;

/** Native adapter for the opaque object-key metadata of package assets. */
@Repository
public class PluginPackageObjectRepositoryAdapter implements PluginPackageObjectRepository {

    private final EntityManager entityManager;

    public PluginPackageObjectRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public void saveAll(List<PluginPackageObject> objects) {
        for (PluginPackageObject object : objects) {
            entityManager.createNativeQuery("""
                            INSERT INTO plugin.package_objects
                                   (plugin_id, path, object_key, content_type, size_bytes,
                                    sha256)
                            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                            """)
                    .setParameter(1, object.pluginId())
                    .setParameter(2, object.path())
                    .setParameter(3, object.objectKey())
                    .setParameter(4, object.contentType())
                    .setParameter(5, object.sizeBytes())
                    .setParameter(6, object.sha256())
                    .executeUpdate();
        }
    }

    @Override
    public Optional<PluginPackageObject> find(String pluginId, String path) {
        List<?> rows = entityManager.createNativeQuery("""
                        SELECT object_key, content_type, size_bytes, sha256
                          FROM plugin.package_objects
                         WHERE plugin_id = ?1 AND path = ?2
                        """)
                .setParameter(1, pluginId)
                .setParameter(2, path)
                .getResultList();
        return rows.stream().findFirst().map(row -> {
            Object[] values = (Object[]) row;
            return new PluginPackageObject(pluginId, path, (String) values[0],
                    (String) values[1], ((Number) values[2]).longValue(),
                    (String) values[3]);
        });
    }

    @Override
    public List<PluginPackageObject> findByPluginId(String pluginId) {
        List<?> rows = entityManager.createNativeQuery("""
                        SELECT path, object_key, content_type, size_bytes, sha256
                          FROM plugin.package_objects
                         WHERE plugin_id = ?1
                         ORDER BY path
                        """)
                .setParameter(1, pluginId)
                .getResultList();
        return rows.stream().map(row -> {
            Object[] values = (Object[]) row;
            return new PluginPackageObject(pluginId, (String) values[0], (String) values[1],
                    (String) values[2], ((Number) values[3]).longValue(),
                    (String) values[4]);
        }).toList();
    }
}
