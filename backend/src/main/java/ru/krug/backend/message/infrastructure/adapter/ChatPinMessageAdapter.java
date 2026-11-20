package ru.krug.backend.message.infrastructure.adapter;

import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.UUID;

import org.springframework.stereotype.Component;

import ru.krug.backend.chat.application.port.ChatPinMessagePort;
import ru.krug.backend.message.infrastructure.persistence.MessageJpaRepository;

/**
 * Resolves whether a message can be pinned without leaving the message context (P0-2 / #80).
 * Only existence, chat/workspace ownership and the delete tombstone are observed: the body,
 * ciphertext and envelopes are never read, and E2EE pins are rejected before this check.
 */
@Component
public class ChatPinMessageAdapter implements ChatPinMessagePort {

    private final MessageJpaRepository messages;

    public ChatPinMessageAdapter(MessageJpaRepository messages) {
        this.messages = messages;
    }

    @Override
    public boolean isAccessibleMessage(UUID workspaceId, UUID chatId, UUID messageId) {
        return messages.findChatId(workspaceId, chatId, messageId).isPresent();
    }

    @Override
    public Set<UUID> filterAccessible(UUID workspaceId, UUID chatId,
                                      Collection<UUID> messageIds) {
        Set<UUID> accessible = new LinkedHashSet<>();
        for (UUID messageId : messageIds) {
            if (isAccessibleMessage(workspaceId, chatId, messageId)) {
                accessible.add(messageId);
            }
        }
        return accessible;
    }
}
