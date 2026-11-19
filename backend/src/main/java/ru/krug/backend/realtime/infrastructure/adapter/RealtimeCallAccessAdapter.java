package ru.krug.backend.realtime.infrastructure.adapter;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.model.ChatAccess;
import ru.krug.backend.chat.application.port.ChatAccessPort;
import ru.krug.backend.chat.application.port.ChatWorkspacePort;
import ru.krug.backend.chat.domain.repository.ChatRepository;
import ru.krug.backend.realtime.application.model.RealtimeCallAccess;
import ru.krug.backend.realtime.application.port.RealtimeCallAccessPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;

/**
 * Call gate over the chat context: ACTIVE membership plus a live DIRECT chat. Denials are
 * returned as values (never thrown) so the WS transport can answer without a rollback-only
 * read transaction and without revealing whether the chat exists or is a GROUP.
 */
@Component
public class RealtimeCallAccessAdapter implements RealtimeCallAccessPort {

    private static final String DIRECT = "DIRECT";

    private final ChatAccessPort chatAccess;
    private final ChatWorkspacePort chatWorkspace;
    private final ChatRepository chatRepository;
    private final TenantContext tenantContext;

    public RealtimeCallAccessAdapter(ChatAccessPort chatAccess, ChatWorkspacePort chatWorkspace,
                                     ChatRepository chatRepository, TenantContext tenantContext) {
        this.chatAccess = chatAccess;
        this.chatWorkspace = chatWorkspace;
        this.chatRepository = chatRepository;
        this.tenantContext = tenantContext;
    }

    @Override
    @Transactional(readOnly = true)
    public RealtimeCallAccess check(UUID workspaceId, UUID chatId, UUID userId,
                                    String requestId) {
        UUID resolvedWorkspace = workspaceId;
        if (resolvedWorkspace == null) {
            Optional<UUID> found = chatWorkspace.findWorkspaceForChat(chatId, userId);
            if (found.isEmpty()) {
                return RealtimeCallAccess.forbidden(null);
            }
            resolvedWorkspace = found.get();
        }
        final UUID workspace = resolvedWorkspace;
        tenantContext.activate(new Principal(userId, null, workspace,
                requestId == null ? "realtime-call" : requestId));

        Optional<ChatAccess> access = chatAccess.findActiveChat(workspace, chatId, userId);
        if (access.isEmpty()) {
            return RealtimeCallAccess.forbidden(workspace);
        }
        if (!DIRECT.equals(access.get().chatType())) {
            return RealtimeCallAccess.notDirect(workspace);
        }
        List<UUID> members = chatRepository.findActiveMemberIds(workspace, chatId);
        return RealtimeCallAccess.accepted(workspace, members);
    }
}
