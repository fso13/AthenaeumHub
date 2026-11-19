package ru.krug.backend.plugin.infrastructure.persistence;

import java.util.List;
import java.util.Optional;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.plugin.domain.model.Plugin;
import ru.krug.backend.plugin.domain.model.PluginMode;
import ru.krug.backend.plugin.domain.model.PluginPermission;
import ru.krug.backend.plugin.domain.model.PluginState;
import ru.krug.backend.plugin.domain.repository.PluginCatalogRepository;

/**
 * Native read-only adapter over {@code plugin.catalog}. The table is a global built-in
 * catalog with no RLS; {@code krug_app} only has SELECT. Arrays are flattened with
 * {@code array_to_string} so the adapter stays independent of JDBC array type handling.
 */
@Repository
public class PluginCatalogAdapter implements PluginCatalogRepository {

    private static final String SELECT = """
            SELECT id,
                   name,
                   description,
                   icon,
                   array_to_string(permissions, ',') AS permissions,
                   array_to_string(modes, ',') AS modes,
                   state
              FROM plugin.catalog
            """;

    private final EntityManager entityManager;

    public PluginCatalogAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public List<Plugin> findAll() {
        List<?> rows = entityManager.createNativeQuery(SELECT + " ORDER BY sort_order, id")
                .getResultList();
        return rows.stream().map(row -> toDomain((Object[]) row)).toList();
    }

    @Override
    public Optional<Plugin> findById(String pluginId) {
        List<?> rows = entityManager.createNativeQuery(SELECT + " WHERE id = ?1")
                .setParameter(1, pluginId)
                .getResultList();
        return rows.stream().findFirst().map(row -> toDomain((Object[]) row));
    }

    private static Plugin toDomain(Object[] row) {
        return new Plugin(
                (String) row[0],
                (String) row[1],
                (String) row[2],
                (String) row[3],
                csv(row[4]).stream().map(PluginPermission::valueOf).toList(),
                csv(row[5]).stream().map(PluginMode::valueOf).toList(),
                PluginState.valueOf((String) row[6]));
    }

    private static List<String> csv(Object value) {
        if (value == null) {
            return List.of();
        }
        String raw = value.toString();
        if (raw.isBlank()) {
            return List.of();
        }
        return java.util.Arrays.stream(raw.split(","))
                .map(String::strip)
                .filter(part -> !part.isEmpty())
                .toList();
    }
}
