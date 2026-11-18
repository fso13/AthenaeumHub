package ru.krug.backend.chat.application.usecase;

import java.util.Optional;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.port.ChatWorkspacePort;
import ru.krug.backend.chat.domain.repository.ChatRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;

/**
 * Resolves a chat's workspace with only the user GUC active. The read-only RLS policy
 * added in V6 lets a member see the chat before the workspace GUC is known.
 */
@Service
public class ChatWorkspaceResolver implements ChatWorkspacePort {

    private final TenantContext tenantContext;
    private final ChatRepository chatRepository;

    public ChatWorkspaceResolver(TenantContext tenantContext, ChatRepository chatRepository) {
        this.tenantContext = tenantContext;
        this.chatRepository = chatRepository;
    }

    @Override
    @Transactional(readOnly = true)
    public UUID workspaceForChat(UUID chatId, UUID userId, String requestId) {
        return findWorkspaceForChat(chatId, userId)
                .orElseThrow(() -> DomainException.notFound("Chat not found"));
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<UUID> findWorkspaceForChat(UUID chatId, UUID userId) {
        tenantContext.activate(new Principal(userId, null, null, "realtime"));
        return chatRepository.findWorkspaceIdForActiveMember(chatId, userId);
    }
}
