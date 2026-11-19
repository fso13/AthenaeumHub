package ru.krug.backend.chat.application.usecase;

import java.util.List;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.port.ChatAccessPort;
import ru.krug.backend.chat.application.port.ChatWorkspacePort;
import ru.krug.backend.chat.domain.repository.ChatRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;

/** Active chat-member ids for the group-call participant picker; no profile data. */
@Service
public class ChatMembersQueryService {

    private final ChatWorkspacePort chatWorkspace;
    private final ChatAccessPort chatAccess;
    private final ChatRepository chatRepository;
    private final TenantContext tenantContext;

    public ChatMembersQueryService(ChatWorkspacePort chatWorkspace, ChatAccessPort chatAccess,
                                   ChatRepository chatRepository, TenantContext tenantContext) {
        this.chatWorkspace = chatWorkspace;
        this.chatAccess = chatAccess;
        this.chatRepository = chatRepository;
        this.tenantContext = tenantContext;
    }

    @Transactional(readOnly = true)
    public List<UUID> list(Principal principal, UUID chatId) {
        UUID workspaceId = chatWorkspace.workspaceForChat(chatId, principal.userId(),
                principal.requestId());
        // Bind the tenant GUC explicitly: the Keycloak principal has no workspace claim,
        // and without it the chat_members self-read RLS policy hides the other members.
        tenantContext.activate(new Principal(principal.userId(), principal.deviceId(),
                workspaceId, principal.requestId(), principal.sessionId()));
        chatAccess.requireActiveChat(workspaceId, chatId, principal.userId());
        return chatRepository.findActiveMemberIds(workspaceId, chatId);
    }
}
