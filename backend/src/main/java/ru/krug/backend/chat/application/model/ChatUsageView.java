package ru.krug.backend.chat.application.model;

/**
 * Limits and counters for the caller in one workspace. Counts are ACTIVE chat memberships
 * of the caller and non-deleted chats of the workspace, read in the creation transaction.
 */
public record ChatUsageView(
        int maxChatsPerUser,
        int maxChatsPerWorkspace,
        long chatsUsedByUser,
        long chatsUsedInWorkspace) {
}
