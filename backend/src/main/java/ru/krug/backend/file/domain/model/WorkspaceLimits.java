package ru.krug.backend.file.domain.model;

import java.util.UUID;

/**
 * Effective server-side limits for one workspace. GUEST members use guest_file_bytes for a
 * single file but still consume the shared workspace storage quota.
 */
public record WorkspaceLimits(
        UUID workspaceId,
        Tariff tariff,
        long maxFileBytes,
        long storageBytes,
        int maxAttachments,
        long guestFileBytes,
        int retentionMonths) {

    public static WorkspaceLimits defaults(UUID workspaceId) {
        Tariff tariff = Tariff.TEAM;
        return new WorkspaceLimits(workspaceId, tariff, tariff.maxFileBytes(),
                tariff.storageBytes(), tariff.maxAttachments(), tariff.guestFileBytes(),
                tariff.retentionMonths());
    }

    public long effectiveMaxFileBytes(boolean guest) {
        return guest ? Math.min(maxFileBytes, guestFileBytes) : maxFileBytes;
    }
}
