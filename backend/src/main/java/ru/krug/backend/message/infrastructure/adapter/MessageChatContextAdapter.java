package ru.krug.backend.message.infrastructure.adapter;

import java.util.UUID;

import org.springframework.stereotype.Component;

import ru.krug.backend.chat.domain.model.Chat;
import ru.krug.backend.chat.domain.repository.ChatRepository;
import ru.krug.backend.message.application.port.MessageChatContextPort;
import ru.krug.backend.shared.error.DomainException;

/**
 * Reads the chat type and derives the DIRECT peer from {@code chat_members} (the chat row
 * does not store it). Only used on the E2EE send path, after membership was already
 * enforced by the chat access port.
 */
@Component
public class MessageChatContextAdapter implements MessageChatContextPort {

    private final ChatRepository chatRepository;

    public MessageChatContextAdapter(ChatRepository chatRepository) {
        this.chatRepository = chatRepository;
    }

    @Override
    public ChatContext require(UUID workspaceId, UUID chatId, UUID userId) {
        Chat chat = chatRepository.findById(workspaceId, chatId)
                .orElseThrow(() -> DomainException.notFound("Chat not found"));
        UUID peerUserId = null;
        if (chat.type() == Chat.Type.DIRECT) {
            peerUserId = chatRepository.findActiveMemberIds(workspaceId, chatId).stream()
                    .filter(member -> !member.equals(userId))
                    .findFirst()
                    .orElse(null);
        }
        return new ChatContext(chat.type().name(), peerUserId);
    }
}
