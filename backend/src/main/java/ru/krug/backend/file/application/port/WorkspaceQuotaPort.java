package ru.krug.backend.file.application.port;

import java.time.Instant;
import java.util.UUID;

import ru.krug.backend.file.domain.model.QuotaReservation;
import ru.krug.backend.file.domain.model.QuotaUsage;
import ru.krug.backend.file.domain.model.WorkspaceLimits;

/**
 * Quota transaction boundary. reserve()/commit()/release() run in the caller's transaction
 * and lock workspace_usage FOR UPDATE, so used + reserved + new <= limit is enforced
 * atomically and concurrent uploads cannot overbook.
 */
public interface WorkspaceQuotaPort {

    WorkspaceLimits limits(UUID workspaceId);

    QuotaUsage usage(UUID workspaceId);

    QuotaReservation reserve(UUID workspaceId, UUID uploadId, long sizeBytes, Instant now,
                             Instant expiresAt);

    /** ACTIVE -> COMMITTED, reserved -> used exactly once (idempotent by reservation status). */
    void commit(UUID workspaceId, UUID uploadId, Instant now);

    /** ACTIVE -> RELEASED/EXPIRED, reserved -> free. */
    void releaseActive(UUID workspaceId, UUID uploadId, Instant now, boolean expired);

    /** COMMITTED -> RELEASED, used -> free (GC / quarantine). */
    void releaseCommitted(UUID workspaceId, UUID uploadId, Instant now);

    int expireStaleReservations(Instant now, int limit);

    int reconcileStorage(int limit);
}
