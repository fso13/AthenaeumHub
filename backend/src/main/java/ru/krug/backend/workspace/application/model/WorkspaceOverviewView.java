package ru.krug.backend.workspace.application.model;

import java.time.Instant;
import java.util.List;

/**
 * Workspace dashboard aggregate. Counts/bytes plus the five most recent audit actions for
 * OWNER/ADMIN callers; a regular member receives an empty audit list. No content, filename,
 * E2EE envelope or token is carried by this model.
 */
public record WorkspaceOverviewView(
        long membersTotal,
        long membersOnline,
        long chatsTotal,
        long messagesTotal,
        long messagesLast24h,
        long filesTotal,
        long filesUsedBytes,
        long filesReservedBytes,
        long dlpEventsLast24h,
        long storageQuotaBytes,
        List<WorkspaceAuditView> auditRecent,
        Instant generatedAt) {
}
