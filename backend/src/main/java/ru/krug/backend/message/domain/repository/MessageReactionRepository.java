package ru.krug.backend.message.domain.repository;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import ru.krug.backend.message.domain.model.MessageReaction;

/**
 * Reactions are idempotent by {@code (message, user, emoji)}. Every method runs under the
 * tenant GUCs, so RLS limits the rows to the caller's workspace even before the explicit
 * message/chat filters.
 */
public interface MessageReactionRepository {

    /** Adds the reaction if absent; never creates a duplicate and never fails on repeat. */
    void add(UUID workspaceId, UUID chatId, UUID messageId, UUID userId, String emoji,
             Instant createdAt);

    /** Removes only the caller's reaction; a missing row is a successful no-op. */
    void remove(UUID workspaceId, UUID chatId, UUID messageId, UUID userId, String emoji);

    /** Unique users for one emoji on one message (0 when absent). */
    long count(UUID workspaceId, UUID messageId, String emoji);

    /**
     * One windowed aggregation for a whole page: keyed by message id, each list has at most
     * one entry per emoji with {@code me} computed for {@code viewerId}. No per-message query.
     */
    Map<UUID, List<MessageReaction>> summarize(UUID workspaceId, Collection<UUID> messageIds,
                                               UUID viewerId);

    /** Delete-for-all: reactions on a tombstone are content-adjacent metadata and are removed. */
    void deleteForMessage(UUID workspaceId, UUID messageId);
}
