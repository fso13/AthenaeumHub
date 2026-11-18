package ru.krug.backend.ops.application.model;

import java.util.UUID;

/** Storage dashboard row for one workspace (quota aggregates + counts only). */
public record AdminStorageWorkspaceView(
        UUID workspaceId,
        String workspaceName,
        String securityMode,
        long usedBytes,
        long reservedBytes,
        long storageLimitBytes,
        long objects,
        long attachments) {
}
