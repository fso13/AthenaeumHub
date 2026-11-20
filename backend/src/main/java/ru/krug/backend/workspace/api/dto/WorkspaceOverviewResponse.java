package ru.krug.backend.workspace.api.dto;

import java.time.Instant;
import java.util.List;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Response of {@code GET /workspaces/{id}/overview} (contract {@code WorkspaceOverview}).
 * Aggregate counts only plus a bounded five-row audit preview; no message/file content or
 * per-user record is present.
 */
public record WorkspaceOverviewResponse(
        Members members,
        long chats,
        Messages messages,
        Files files,
        Dlp dlp,
        Storage storage,
        List<WorkspaceAuditEventResponse> auditRecent,
        Instant generatedAt) {

    public record Members(long total, long online) {
    }

    public record Messages(long total, @JsonProperty("last_24h") long last24h) {
    }

    public record Files(long total, long usedBytes, long reservedBytes) {
    }

    public record Dlp(@JsonProperty("events_last_24h") long eventsLast24h) {
    }

    public record Storage(long usedBytes, long quotaBytes) {
    }
}
