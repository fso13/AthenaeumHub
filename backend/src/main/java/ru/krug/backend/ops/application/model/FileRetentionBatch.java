package ru.krug.backend.ops.application.model;

import java.util.List;
import java.util.UUID;

/**
 * One bounded attachment retention batch. {@code objectKeys} are storage keys (server-side
 * UUID paths, never a file name) that the orchestrator deletes after the DB transaction
 * commits; {@code uploadIds} are available for diagnostics/quota reconciliation.
 */
public record FileRetentionBatch(int deleted, List<UUID> uploadIds, List<String> objectKeys) {

    public FileRetentionBatch {
        uploadIds = uploadIds == null ? List.of() : List.copyOf(uploadIds);
        objectKeys = objectKeys == null ? List.of() : List.copyOf(objectKeys);
    }
}
