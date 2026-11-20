package ru.krug.backend.workspace.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.workspace.domain.model.WorkspaceOverviewStats;
import ru.krug.backend.workspace.domain.repository.WorkspaceOverviewRepository;

/**
 * Calls the V49 {@code workspace.overview_stats} SECURITY DEFINER aggregate. The function
 * filters by workspace and re-checks the caller's ACTIVE membership; it returns counts and
 * byte totals only, never a row of message/file content.
 */
@Repository
public class WorkspaceOverviewRepositoryAdapter implements WorkspaceOverviewRepository {

    private final EntityManager entityManager;

    public WorkspaceOverviewRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public Optional<WorkspaceOverviewStats> stats(UUID workspaceId, UUID callerId, Instant now) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT members_total, chats_total, messages_total, messages_last_24h,
                               files_total, files_used_bytes, files_reserved_bytes,
                               storage_quota_bytes, dlp_events_last_24h
                          FROM workspace.overview_stats(CAST(?1 AS uuid), CAST(?2 AS uuid),
                                                        CAST(?3 AS timestamptz))
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, callerId)
                .setParameter(3, Timestamp.from(now))
                .getResultList();
        return rows.stream().findFirst().map(row -> new WorkspaceOverviewStats(
                number(row[0]), number(row[1]), number(row[2]), number(row[3]), number(row[4]),
                number(row[5]), number(row[6]), number(row[7]), number(row[8])));
    }

    private static long number(Object value) {
        return value == null ? 0L : ((Number) value).longValue();
    }
}
