package ru.krug.backend.realtime.infrastructure.adapter;

import java.util.Optional;
import java.util.UUID;

import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.model.ChatAccess;
import ru.krug.backend.chat.application.port.ChatAccessPort;
import ru.krug.backend.chat.application.port.ChatWorkspacePort;
import ru.krug.backend.realtime.application.model.RealtimeChatAccess;
import ru.krug.backend.realtime.application.port.RealtimeChatAccessPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;

/**
 * Bridges realtime subscriptions to the chat context's published access ports. Denials are
 * converted to {@code accepted=false} without throwing: throwing a DomainException inside a
 * read-only transaction would mark it rollback-only and surface as a transport error.
 */
@Component
public class RealtimeChatAccessAdapter implements RealtimeChatAccessPort {

    private final ChatAccessPort chatAccess;
    private final ChatWorkspacePort chatWorkspace;
    private final TenantContext tenantContext;

    public RealtimeChatAccessAdapter(ChatAccessPort chatAccess, ChatWorkspacePort chatWorkspace,
                                     TenantContext tenantContext) {
        this.chatAccess = chatAccess;
        this.chatWorkspace = chatWorkspace;
        this.tenantContext = tenantContext;
    }

    @Override
    @Transactional(readOnly = true)
    public RealtimeChatAccess check(UUID workspaceId, UUID chatId, UUID userId,
                                    String requestId) {
        UUID resolvedWorkspace = workspaceId;
        if (resolvedWorkspace == null) {
            Optional<UUID> found = chatWorkspace.findWorkspaceForChat(chatId, userId);
            if (found.isEmpty()) {
                return RealtimeChatAccess.forbidden(null);
            }
            resolvedWorkspace = found.get();
        }
        final UUID workspace = resolvedWorkspace;
        tenantContext.activate(new Principal(userId, null, workspace,
                requestId == null ? "realtime" : requestId));
        return chatAccess.findActiveChat(workspace, chatId, userId)
                .map(access -> RealtimeChatAccess.accepted(workspace, access.lastSeq()))
                .orElseGet(() -> RealtimeChatAccess.forbidden(workspace));
    }
}
