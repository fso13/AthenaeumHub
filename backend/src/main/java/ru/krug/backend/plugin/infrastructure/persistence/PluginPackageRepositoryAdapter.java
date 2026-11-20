package ru.krug.backend.plugin.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.plugin.domain.model.PluginMode;
import ru.krug.backend.plugin.domain.model.PluginPackage;
import ru.krug.backend.plugin.domain.repository.PluginPackageRepository;

/**
 * Native adapter for {@code plugin.packages} joined with the external catalog row. Only
 * installed external packages are returned; uninstall deletes the package row and keeps
 * the catalog tombstone (so chat toggles referencing the id never break the FK).
 */
@Repository
public class PluginPackageRepositoryAdapter implements PluginPackageRepository {

    private static final String SELECT = """
            SELECT c.id,
                   c.name,
                   c.version,
                   c.description,
                   c.author,
                   c.entry,
                   array_to_string(c.permissions, ',') AS permissions,
                   array_to_string(c.modes, ',') AS modes,
                   p.archive_sha256,
                   p.archive_size_bytes,
                   p.unpacked_size_bytes,
                   p.file_count,
                   p.installed_by,
                   p.installed_at
              FROM plugin.packages p
              JOIN plugin.catalog c ON c.id = p.plugin_id
             WHERE c.kind = 'EXTERNAL' AND c.install_state = 'INSTALLED'
            """;

    private final EntityManager entityManager;

    public PluginPackageRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public List<PluginPackage> findAll() {
        List<?> rows = entityManager.createNativeQuery(SELECT + " ORDER BY p.installed_at DESC, c.id")
                .getResultList();
        return rows.stream().map(row -> toDomain((Object[]) row)).toList();
    }

    @Override
    public Optional<PluginPackage> findByPluginId(String pluginId) {
        List<?> rows = entityManager.createNativeQuery(SELECT + " AND c.id = ?1")
                .setParameter(1, pluginId)
                .getResultList();
        return rows.stream().findFirst().map(row -> toDomain((Object[]) row));
    }

    @Override
    public void save(PluginPackage pluginPackage) {
        entityManager.createNativeQuery("""
                        INSERT INTO plugin.packages
                               (plugin_id, archive_sha256, archive_size_bytes,
                                unpacked_size_bytes, file_count, entry, installed_by,
                                installed_at)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                        """)
                .setParameter(1, pluginPackage.pluginId())
                .setParameter(2, pluginPackage.archiveSha256())
                .setParameter(3, pluginPackage.archiveSizeBytes())
                .setParameter(4, pluginPackage.unpackedSizeBytes())
                .setParameter(5, pluginPackage.fileCount())
                .setParameter(6, pluginPackage.entry())
                .setParameter(7, pluginPackage.installedBy())
                .setParameter(8, Timestamp.from(pluginPackage.installedAt()))
                .executeUpdate();
    }

    @Override
    public void delete(String pluginId) {
        entityManager.createNativeQuery("DELETE FROM plugin.packages WHERE plugin_id = ?1")
                .setParameter(1, pluginId)
                .executeUpdate();
    }

    private static PluginPackage toDomain(Object[] row) {
        return new PluginPackage(
                (String) row[0],
                (String) row[1],
                (String) row[2],
                (String) row[3],
                (String) row[4],
                (String) row[5],
                csv(row[6]),
                csv(row[7]).stream().map(PluginMode::valueOf).toList(),
                (String) row[8],
                ((Number) row[9]).longValue(),
                ((Number) row[10]).longValue(),
                ((Number) row[11]).intValue(),
                (UUID) row[12],
                instant(row[13]));
    }

    private static Instant instant(Object value) {
        if (value instanceof Instant instant) {
            return instant;
        }
        if (value instanceof Timestamp timestamp) {
            return timestamp.toInstant();
        }
        if (value instanceof java.time.OffsetDateTime offsetDateTime) {
            return offsetDateTime.toInstant();
        }
        throw new IllegalStateException("Unsupported timestamp type");
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
