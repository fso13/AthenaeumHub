package ru.krug.backend.file.api.dto;

public record WorkspaceLimitsResponse(
        String tariff,
        long maxFileBytes,
        long storageBytes,
        int maxAttachments,
        long guestFileBytes,
        WorkspaceUsageResponse usage,
        int maxChatsPerUser,
        long chatsUsed) {
}
