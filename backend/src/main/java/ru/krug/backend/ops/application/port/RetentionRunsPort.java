package ru.krug.backend.ops.application.port;

import java.time.Instant;
import java.util.UUID;

/** Stores per-workspace retention counters (#101); ids/counters only, never content. */
public interface RetentionRunsPort {

    void record(UUID workspaceId, Instant startedAt, Instant finishedAt, int retentionDays,
                int messagesDeleted, int filesDeleted, int batches, String status,
                String errorCode);
}
