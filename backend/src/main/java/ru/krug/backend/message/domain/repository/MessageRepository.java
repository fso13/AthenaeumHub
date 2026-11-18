package ru.krug.backend.message.domain.repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.message.domain.model.Message;

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
}
