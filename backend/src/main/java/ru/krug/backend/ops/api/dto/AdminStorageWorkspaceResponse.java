package ru.krug.backend.ops.api.dto;

import java.util.UUID;

/** Response DTO for one storage dashboard workspace row (contract
 * {@code AdminStorageWorkspace}). */
public record AdminStorageWorkspaceResponse(
        UUID workspaceId,
        String workspaceName,
        String securityMode,
        long usedBytes,
        long reservedBytes,
        long storageLimitBytes,
        long objects,
        long attachments) {
}
