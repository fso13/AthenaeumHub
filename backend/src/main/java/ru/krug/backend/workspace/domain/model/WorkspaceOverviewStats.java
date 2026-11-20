package ru.krug.backend.workspace.domain.model;

/**
 * Content-free aggregate of one workspace. Only counts, byte totals and quotas are carried;
 * no message body, E2EE envelope, filename or per-user field exists in this record.
 */
public record WorkspaceOverviewStats(
        long membersTotal,
        long chatsTotal,
        long messagesTotal,
        long messagesLast24h,
        long filesTotal,
        long filesUsedBytes,
        long filesReservedBytes,
        long storageQuotaBytes,
        long dlpEventsLast24h) {
}
