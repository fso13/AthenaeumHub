package ru.krug.backend.plugin.domain.repository;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.plugin.domain.model.Poll;

/**
 * Poll persistence. Every query carries the tenant workspace/chat and relies on forced
 * RLS as the second line of defence. The repository never reads chat/message content.
 */
public interface PollRepository {

    /** Inserts the poll and all its options atomically. */
    Poll create(Poll poll);

    /** Viewer-relative poll (vote counts + {@code myOptionId}); empty when foreign/hidden. */
    Optional<Poll> findById(UUID workspaceId, UUID chatId, UUID pollId, UUID viewerId);

    /** Newest first; viewer-relative vote counts for every poll in one bounded query. */
    List<Poll> findByChat(UUID workspaceId, UUID chatId, UUID viewerId, int limit);

    /** Bounded batch read for embedded message projections; viewer-relative. */
    List<Poll> findByIds(UUID workspaceId, UUID chatId, Collection<UUID> pollIds,
                         UUID viewerId);

    /**
     * One vote per (poll,user): inserts a new vote or moves the existing one.
     *
     * @return {@code true} only when the stored option actually changed; repeating the
     *         same option returns {@code false} (idempotent, no second audit).
     */
    boolean vote(UUID workspaceId, UUID chatId, UUID pollId, UUID optionId, UUID userId,
                 Instant at);

    /**
     * @return {@code true} only when the open poll was closed by this call; an already
     *         closed poll returns {@code false} (idempotent, no second audit).
     */
    boolean close(UUID workspaceId, UUID chatId, UUID pollId, Instant closedAt);
}
