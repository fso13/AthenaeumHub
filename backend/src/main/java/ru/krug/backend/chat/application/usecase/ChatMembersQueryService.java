package ru.krug.backend.chat.application.usecase;

import java.util.List;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.model.ChatMemberListView;
import ru.krug.backend.chat.application.model.ChatMemberView;
import ru.krug.backend.chat.application.port.ChatAccessPort;
import ru.krug.backend.chat.application.port.ChatWorkspacePort;
import ru.krug.backend.chat.domain.model.ChatMemberRow;
import ru.krug.backend.chat.domain.repository.ChatRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;

/**
 * ACTIVE chat members for the member list and the group-call participant picker (#79).
 * Display names come from the narrow {@code chat.member_directory} lookup; email, devices
 * and keys are never read or returned. Only an ACTIVE participant of the chat may list it.
 */
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
    public ChatMemberListView list(Principal principal, UUID chatId) {
        UUID workspaceId = chatWorkspace.workspaceForChat(chatId, principal.userId(),
                principal.requestId());
        // Bind the tenant GUC explicitly: the Keycloak principal has no workspace claim,
        // and without it the chat_members self-read RLS policy hides the other members.
        tenantContext.activate(new Principal(principal.userId(), principal.deviceId(),
                workspaceId, principal.requestId(), principal.sessionId()));
        chatAccess.requireActiveChat(workspaceId, chatId, principal.userId());

        List<ChatMemberRow> rows = chatRepository.findMemberDirectory(chatId,
                principal.userId());
        List<ChatMemberView> members = rows.stream().map(ChatMemberView::from).toList();
        return new ChatMemberListView(rows.stream().map(ChatMemberRow::userId).toList(),
                members);
    }
}
