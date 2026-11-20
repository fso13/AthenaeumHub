package ru.krug.backend.plugin.infrastructure.persistence;

import java.util.List;
import java.util.Optional;
import java.util.stream.Collectors;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.plugin.domain.model.Plugin;
import ru.krug.backend.plugin.domain.model.PluginKind;
import ru.krug.backend.plugin.domain.model.PluginManifest;
import ru.krug.backend.plugin.domain.model.PluginMode;
import ru.krug.backend.plugin.domain.model.PluginState;
import ru.krug.backend.plugin.domain.repository.PluginCatalogRepository;

/**
 * Native adapter over {@code plugin.catalog}. The table is a global catalog with
 * external-only write RLS; {@code krug_app} can read every installed row and can mutate
 * only rows with {@code kind = 'EXTERNAL'}. Arrays are flattened with
 * {@code array_to_string} so the adapter stays independent of JDBC array type handling;
 * writes use an explicit PostgreSQL array literal.
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
                   state,
                   kind,
                   version,
                   author,
                   entry
              FROM plugin.catalog
            """;

    private final EntityManager entityManager;

    public PluginCatalogAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public List<Plugin> findAll() {
        List<?> rows = entityManager.createNativeQuery(
                        SELECT + " WHERE install_state = 'INSTALLED' ORDER BY sort_order, id")
                .getResultList();
        return rows.stream().map(row -> toDomain((Object[]) row)).toList();
    }

    @Override
    public Optional<Plugin> findById(String pluginId) {
        return queryOne(SELECT + " WHERE id = ?1 AND install_state = 'INSTALLED'", pluginId);
    }

    @Override
    public Optional<Plugin> findAnyById(String pluginId) {
        return queryOne(SELECT + " WHERE id = ?1", pluginId);
    }

    @Override
    public void installExternal(PluginManifest manifest) {
        entityManager.createNativeQuery("""
                        INSERT INTO plugin.catalog
                               (id, name, description, icon, permissions, modes, state, kind,
                                install_state, version, author, entry, sort_order)
                        VALUES (?1, ?2, ?3, NULL, CAST(?4 AS text[]), CAST(?5 AS text[]),
                                'ACTIVE', 'EXTERNAL', 'INSTALLED', ?6, ?7, ?8, 1000)
                        ON CONFLICT (id) DO UPDATE
                           SET name = EXCLUDED.name,
                               description = EXCLUDED.description,
                               permissions = EXCLUDED.permissions,
                               modes = EXCLUDED.modes,
                               state = 'ACTIVE',
                               install_state = 'INSTALLED',
                               version = EXCLUDED.version,
                               author = EXCLUDED.author,
                               entry = EXCLUDED.entry,
                               sort_order = EXCLUDED.sort_order,
                               updated_at = now()
                         WHERE plugin.catalog.kind = 'EXTERNAL'
                        """)
                .setParameter(1, manifest.id())
                .setParameter(2, manifest.name())
                .setParameter(3, manifest.description())
                .setParameter(4, arrayLiteral(manifest.permissions()))
                .setParameter(5, arrayLiteral(manifest.modes().stream()
                        .map(PluginMode::name).toList()))
                .setParameter(6, manifest.version())
                .setParameter(7, manifest.author())
                .setParameter(8, manifest.entry())
                .executeUpdate();
    }

    @Override
    public void markUninstalled(String pluginId) {
        entityManager.createNativeQuery("""
                        UPDATE plugin.catalog
                           SET install_state = 'UNINSTALLED',
                               state = 'DISABLED',
                               updated_at = now()
                         WHERE id = ?1 AND kind = 'EXTERNAL'
                        """)
                .setParameter(1, pluginId)
                .executeUpdate();
    }

    private Optional<Plugin> queryOne(String sql, String pluginId) {
        List<?> rows = entityManager.createNativeQuery(sql)
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
                csv(row[4]),
                csv(row[5]).stream().map(PluginMode::valueOf).toList(),
                PluginState.valueOf((String) row[6]),
                PluginKind.valueOf((String) row[7]),
                (String) row[8],
                (String) row[9],
                (String) row[10]);
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

    /**
     * Builds a PostgreSQL text-array literal. Values are already validated closed tokens;
     * quoting/escaping keeps future tokens safe even if they contain a quote.
     */
    private static String arrayLiteral(List<String> values) {
        return values.stream()
                .map(value -> "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\"")
                .collect(Collectors.joining(",", "{", "}"));
    }
}
