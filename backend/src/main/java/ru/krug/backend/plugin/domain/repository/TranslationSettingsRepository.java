package ru.krug.backend.plugin.domain.repository;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.plugin.domain.model.TranslationSettings;

/**
 * Single-row installation translation-provider configuration. The row is optional so a
 * fresh installation continues to honour the {@code KRUG_PLUGINS_TRANSLATE_URL} fallback
 * until an administrator saves an explicit setting.
 */
public interface TranslationSettingsRepository {

    Optional<TranslationSettings> find();

    /** Locks the singleton row (when present) for a read-modify-write PATCH. */
    Optional<TranslationSettings> findForUpdate();

    /** Inserts or updates the singleton row; never stores a credential. */
    void save(TranslationSettings settings, UUID actorId, Instant updatedAt);
}
