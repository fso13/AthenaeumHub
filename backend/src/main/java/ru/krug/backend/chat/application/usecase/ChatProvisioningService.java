package ru.krug.backend.chat.application.usecase;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.command.DefaultChatCommand;
import ru.krug.backend.chat.application.command.DevChatCommand;
import ru.krug.backend.chat.application.port.ChatProvisioningPort;
import ru.krug.backend.chat.domain.model.Chat;
import ru.krug.backend.chat.domain.model.ChatCounter;
import ru.krug.backend.chat.domain.model.ChatMember;
import ru.krug.backend.chat.domain.repository.ChatRepository;

@Service
public class ChatProvisioningService implements ChatProvisioningPort {

    private final ChatRepository chatRepository;

    public ChatProvisioningService(ChatRepository chatRepository) {
        this.chatRepository = chatRepository;
    }

    @Override
    @Transactional
    public void ensureDevGroupChat(DevChatCommand command) {
        Chat chat = Chat.createManagedGroup(command.chatId(), command.workspaceId(),
                command.ownerId(), command.name());
        ChatMember owner = ChatMember.owner(command.chatId(), command.ownerId());
        ChatCounter counter = ChatCounter.newCounter(command.chatId());
        chatRepository.saveChat(chat, owner, counter);
    }

    @Override
    @Transactional
    public void createDefaultGroupChat(DefaultChatCommand command) {
        Chat.SecurityMode mode = Chat.SecurityMode.valueOf(command.securityMode());
        Chat chat = Chat.createGroup(command.chatId(), command.workspaceId(), command.ownerId(),
                command.name(), mode);
        ChatMember owner = ChatMember.owner(command.chatId(), command.ownerId());
        ChatCounter counter = ChatCounter.newCounter(command.chatId());
        chatRepository.saveChat(chat, owner, counter);
    }
}
