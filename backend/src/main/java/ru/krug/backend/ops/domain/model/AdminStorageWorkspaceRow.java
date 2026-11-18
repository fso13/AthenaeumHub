package ru.krug.backend.ops.domain.model;

import java.util.UUID;

/**
 * One workspace row of the platform-admin storage dashboard. Only quota aggregates and
 * object/attachment counts; filenames, object keys and bytes are not represented.
 */
public record AdminStorageWorkspaceRow(
        UUID workspaceId,
        String workspaceName,
        String securityMode,
        long usedBytes,
        long reservedBytes,
        long storageLimitBytes,
        long objects,
        long attachments) {
}
