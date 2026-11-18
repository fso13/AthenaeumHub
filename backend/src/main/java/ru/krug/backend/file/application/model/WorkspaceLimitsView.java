package ru.krug.backend.file.application.model;

public record WorkspaceLimitsView(
        String tariff,
        long maxFileBytes,
        long storageBytes,
        int maxAttachments,
        long guestFileBytes,
        QuotaView usage,
        int maxChatsPerUser,
        long chatsUsed) {

    /** Back-compat constructor for callers that only need file limits. */
    public WorkspaceLimitsView(String tariff, long maxFileBytes, long storageBytes,
                               int maxAttachments, long guestFileBytes, QuotaView usage) {
        this(tariff, maxFileBytes, storageBytes, maxAttachments, guestFileBytes, usage, 0, 0);
    }
}
