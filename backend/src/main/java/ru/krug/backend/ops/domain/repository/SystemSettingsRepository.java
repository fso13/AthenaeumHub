package ru.krug.backend.ops.domain.repository;

import ru.krug.backend.ops.domain.model.SystemSettings;

public interface SystemSettingsRepository {

    /** Loads the singleton row; V22 seeds it, so a missing row is a broken deployment. */
    SystemSettings load();

    /**
     * Locks the singleton row for the caller's transaction. Used by setup completion and
     * settings updates so concurrent PATCHes cannot both observe {@code setup_completed=false}.
     */
    SystemSettings loadForUpdate();

    void save(SystemSettings settings);
}
