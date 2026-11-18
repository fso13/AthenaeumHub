package ru.krug.backend.chat.application.usecase;

import java.util.Optional;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.model.ChatDirectorySnapshot;
import ru.krug.backend.chat.application.port.ChatMemberDirectoryPort;
import ru.krug.backend.chat.domain.model.Chat;
import ru.krug.backend.chat.domain.repository.ChatRepository;

@Service
public class ChatMemberDirectoryService implements ChatMemberDirectoryPort {

    private final ChatRepository chatRepository;

    public ChatMemberDirectoryService(ChatRepository chatRepository) {
        this.chatRepository = chatRepository;
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<ChatDirectorySnapshot> find(UUID workspaceId, UUID chatId) {
        return chatRepository.findById(workspaceId, chatId)
                .map(chat -> new ChatDirectorySnapshot(chat.id(), chat.workspaceId(),
                        chat.name(), chat.securityMode() == Chat.SecurityMode.E2EE,
                        chatRepository.findActiveMemberIds(workspaceId, chatId)));
    }
}
