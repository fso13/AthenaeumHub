package ru.krug.backend.ops.application.port;

import java.time.Instant;
import java.util.UUID;

import ru.krug.backend.ops.application.model.FileRetentionBatch;
import ru.krug.backend.ops.application.model.MessageRetentionBatch;

/**
 * Bounded, tenant-scoped retention writes (#101). Each call runs in its own transaction
 * with the workspace GUC set by the implementation, so a large workspace is drained in
 * small batches instead of one long lock. Both operations are idempotent: a row that is
 * already soft-deleted is never selected again.
 */
public interface ContentRetentionPort {

    /** Soft-deletes at most {@code limit} messages created before {@code cutoff}. */
    MessageRetentionBatch softDeleteMessages(UUID workspaceId, Instant cutoff, int limit);

    /**
     * Soft-deletes at most {@code limit} attachments created before {@code cutoff} and
     * returns the storage keys of the deleted objects.
     */
    FileRetentionBatch softDeleteFiles(UUID workspaceId, Instant cutoff, int limit);
}
