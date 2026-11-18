package ru.krug.backend.message.domain.repository;

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

    List<Message> findPage(UUID workspaceId, UUID chatId, Long afterSeq, Long beforeSeq,
                           int limitPlusOne);

    /** Main feed: only messages that are not thread replies ({@code thread_root_id IS NULL}). */
    List<Message> findMainPage(UUID workspaceId, UUID chatId, Long afterSeq, Long beforeSeq,
                               int limitPlusOne);

    /** Replies of one flat thread, ordered exactly like the main feed. */
    List<Message> findThreadPage(UUID workspaceId, UUID chatId, UUID threadRootId, Long afterSeq,
                                 Long beforeSeq, int limitPlusOne);

    /**
     * One windowed query for the summaries of the given roots (no N+1). Roots with no live
     * replies are absent from the result. The excerpt is decrypted here for MANAGED rows and
     * is null for E2EE rows.
     */
    Map<UUID, ThreadSummary> findThreadSummaries(UUID workspaceId, UUID chatId,
                                                 Collection<UUID> threadRootIds);
}
