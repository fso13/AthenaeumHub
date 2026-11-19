package ru.krug.backend.message.domain.repository;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.message.domain.model.Message;
import ru.krug.backend.message.domain.model.ThreadSummary;

public interface MessageRepository {

    void save(Message message);

    Optional<Message> findById(UUID workspaceId, UUID messageId);

    /**
     * Replay lookup scoped to the sender: another user's client_message_id must never be
     * resolved as "mine" (§4.2 D-07).
     */
    Optional<Message> findByClientMessageId(UUID workspaceId, UUID chatId, UUID clientMessageId,
                                            UUID senderId);

    /** Sender of an existing message with the same client_message_id, for the 409 branch. */
    Optional<UUID> findSenderIdByClientMessageId(UUID workspaceId, UUID chatId,
                                                 UUID clientMessageId);

    Optional<UUID> findChatIdByMessageId(UUID workspaceId, UUID chatId, UUID messageId);

    /**
     * Delete-for-me marker. Idempotent: an existing marker is left untouched (first
     * deletion timestamp wins) and the call still succeeds.
     */
    void hideForUser(UUID workspaceId, UUID chatId, UUID messageId, UUID userId,
                     Instant deletedAt);

    /** True when the caller hid this message from their own timeline. */
    boolean isHiddenForUser(UUID workspaceId, UUID messageId, UUID userId);

    /**
     * Managed-only edit: rewrites the encrypted body, sets {@code edited_at} and increments
     * {@code version}. Returns empty when the row is gone, deleted, not TEXT/MANAGED or the
     * optional optimistic version did not match. The caller already performed the typed
     * authorisation checks; this is the atomic last line of defence.
     */
    Optional<Message> editText(UUID workspaceId, UUID chatId, UUID messageId, String text,
                               Integer expectedVersion, Instant editedAt);

    /**
     * Soft delete for everyone: sets tombstone columns, clears the managed body, increments
     * {@code version} and returns the updated row. Already-deleted rows are returned as-is
     * (idempotent).
     */
    Optional<Message> softDeleteForAll(UUID workspaceId, UUID chatId, UUID messageId,
                                       Instant deletedAt, UUID deletedBy);

    /**
     * @param viewerId caller whose per-user deletion markers are excluded; never null for
     *                 user-facing reads and replay.
     */
    List<Message> findPage(UUID workspaceId, UUID chatId, Long afterSeq, Long beforeSeq,
                           UUID viewerId, int limitPlusOne);

    /** Main feed: only messages that are not thread replies ({@code thread_root_id IS NULL}). */
    List<Message> findMainPage(UUID workspaceId, UUID chatId, Long afterSeq, Long beforeSeq,
                               UUID viewerId, int limitPlusOne);

    /** Replies of one flat thread, ordered exactly like the main feed. */
    List<Message> findThreadPage(UUID workspaceId, UUID chatId, UUID threadRootId, Long afterSeq,
                                 Long beforeSeq, UUID viewerId, int limitPlusOne);

    /**
     * One windowed query for the summaries of the given roots (no N+1). Roots with no live
     * replies are absent from the result. Replies hidden by {@code viewerId} are not counted.
     * The excerpt is decrypted here for MANAGED rows and is null for E2EE rows.
     */
    Map<UUID, ThreadSummary> findThreadSummaries(UUID workspaceId, UUID chatId,
                                                 Collection<UUID> threadRootIds,
                                                 UUID viewerId);
}
