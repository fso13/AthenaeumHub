package ru.krug.backend.workspace.domain.repository;

import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.workspace.domain.model.WorkspaceSecuritySettings;

/** One security-settings row per workspace; the row is created lazily on first read. */
public interface WorkspaceSecuritySettingsRepository {

    Optional<WorkspaceSecuritySettings> find(UUID workspaceId);

    /** Idempotent default insert; does not overwrite an existing row. */
    void insertDefaultIfAbsent(UUID workspaceId);

    void update(WorkspaceSecuritySettings settings);
}
