package ru.krug.backend.chat.application.usecase;

import java.util.Optional;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.model.ChatAccess;
import ru.krug.backend.chat.application.port.ChatAccessPort;
import ru.krug.backend.chat.domain.model.ChatMember;
import ru.krug.backend.chat.domain.repository.ChatRepository;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.workspace.application.port.WorkspaceAccessPort;

@Service
public class ChatAccessService implements ChatAccessPort {

    private final WorkspaceAccessPort workspaceAccess;
    private final ChatRepository chatRepository;

    public ChatAccessService(WorkspaceAccessPort workspaceAccess, ChatRepository chatRepository) {
        this.workspaceAccess = workspaceAccess;
        this.chatRepository = chatRepository;
    }

    @Override
    @Transactional(readOnly = true)
    public ChatAccess requireActiveChat(UUID workspaceId, UUID chatId, UUID userId) {
        workspaceAccess.requireActiveMember(workspaceId, userId);
        var chat = chatRepository.findById(workspaceId, chatId)
                .orElseThrow(() -> DomainException.notFound("Chat not found"));
        ChatMember member = chatRepository.findMember(chatId, userId)
                .filter(ChatMember::isActive)
                .orElseThrow(() -> DomainException.notFound("Chat not found"));
        return new ChatAccess(chatId, workspaceId, chat.type().name(), member.role().name(),
                chat.securityMode().name(), chatRepository.lastSeq(chatId));
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<ChatAccess> findActiveChat(UUID workspaceId, UUID chatId, UUID userId) {
        if (workspaceId == null || chatId == null || userId == null
                || !workspaceAccess.isActiveMember(workspaceId, userId)) {
            return Optional.empty();
        }
        var chat = chatRepository.findById(workspaceId, chatId).orElse(null);
        if (chat == null) {
            return Optional.empty();
        }
        return chatRepository.findMember(chatId, userId)
                .filter(ChatMember::isActive)
                .map(member -> new ChatAccess(chatId, workspaceId, chat.type().name(),
                        member.role().name(), chat.securityMode().name(),
                        chatRepository.lastSeq(chatId)));
    }
}
