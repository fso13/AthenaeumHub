package ru.krug.backend.plugin.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.plugin.domain.model.TranslationProviderKind;
import ru.krug.backend.plugin.domain.model.TranslationSettings;
import ru.krug.backend.plugin.domain.repository.TranslationSettingsRepository;

/**
 * Native singleton persistence for the installation translation configuration. Only
 * {@code enabled}, the URL and the protocol selector exist; there is no credential column
 * to leak.
 */
@Repository
public class TranslationSettingsRepositoryAdapter implements TranslationSettingsRepository {

    private final EntityManager entityManager;

    public TranslationSettingsRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public Optional<TranslationSettings> find() {
        return read("SELECT enabled, url, provider FROM ops.plugin_translation_settings"
                + " WHERE id = 1");
    }

    @Override
    public Optional<TranslationSettings> findForUpdate() {
        return read("SELECT enabled, url, provider FROM ops.plugin_translation_settings"
                + " WHERE id = 1 FOR UPDATE");
    }

    @Override
    public void save(TranslationSettings settings, UUID actorId, Instant updatedAt) {
        entityManager.createNativeQuery("""
                        INSERT INTO ops.plugin_translation_settings
                               (id, enabled, url, provider, updated_at, updated_by)
                        VALUES (1, ?1, ?2, ?3, ?4, ?5)
                        ON CONFLICT (id) DO UPDATE
                           SET enabled = EXCLUDED.enabled,
                               url = EXCLUDED.url,
                               provider = EXCLUDED.provider,
                               updated_at = EXCLUDED.updated_at,
                               updated_by = EXCLUDED.updated_by
                        """)
                .setParameter(1, settings.enabled())
                .setParameter(2, settings.url().isEmpty() ? null : settings.url())
                .setParameter(3, settings.provider().wire())
                .setParameter(4, Timestamp.from(updatedAt))
                .setParameter(5, actorId)
                .executeUpdate();
    }

    private Optional<TranslationSettings> read(String sql) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery(sql).getResultList();
        return rows.stream().findFirst().map(row -> new TranslationSettings(
                Boolean.TRUE.equals(row[0]), row[1] == null ? "" : (String) row[1],
                TranslationProviderKind.fromWireOrDefault((String) row[2])));
    }
}
