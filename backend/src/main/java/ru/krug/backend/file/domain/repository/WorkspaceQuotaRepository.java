package ru.krug.backend.file.domain.repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.file.domain.model.QuotaUsage;
import ru.krug.backend.file.domain.model.WorkspaceLimits;

/**
 * Quota persistence port. The application quota service owns the transaction and the
 * used+reserved+new invariant; this repository only provides locked reads and writes.
 */
public interface WorkspaceQuotaRepository {

    Optional<WorkspaceLimits> findLimits(UUID workspaceId);

    void saveLimits(WorkspaceLimits limits);

    Optional<QuotaUsage> findUsage(UUID workspaceId);

    /** SELECT ... FOR UPDATE; creates the usage row lazily when absent. */
    QuotaUsage lockUsage(UUID workspaceId);

    void saveUsage(UUID workspaceId, QuotaUsage usage);

    /** Used by the daily reconciliation worker. */
    List<UUID> listWorkspaceIds(int limit);

    long committedAttachmentBytes(UUID workspaceId);

    long activeReservationBytes(UUID workspaceId);
}
