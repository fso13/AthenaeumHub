package ru.krug.backend.plugin.infrastructure.adapter;

import java.util.UUID;

import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.model.ChatAccess;
import ru.krug.backend.chat.application.port.ChatAccessPort;
import ru.krug.backend.chat.application.port.ChatWorkspacePort;
import ru.krug.backend.plugin.application.model.PluginChatContext;
import ru.krug.backend.plugin.application.port.PluginChatAccessPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;

/**
 * Plugin-side gate for {@code /chats/{chatId}/plugins}. Mirrors the sticker/message
 * adapters: the workspace is resolved for Keycloak principals (dev tokens carry it
 * already), the tenant GUCs are activated and ACTIVE chat membership is verified through
 * the published chat port. Unknown/deleted/foreign chats stay {@code 404}.
 */
@Component
public class PluginChatAccessAdapter implements PluginChatAccessPort {

    private final TenantContext tenantContext;
    private final ChatWorkspacePort chatWorkspace;
    private final ChatAccessPort chatAccess;

    public PluginChatAccessAdapter(TenantContext tenantContext,
                                   ChatWorkspacePort chatWorkspace,
                                   ChatAccessPort chatAccess) {
        this.tenantContext = tenantContext;
        this.chatWorkspace = chatWorkspace;
        this.chatAccess = chatAccess;
    }

    @Override
    @Transactional
    public PluginChatContext requireActiveChat(Principal principal, UUID chatId) {
        UUID workspaceId = principal.workspaceId();
        if (workspaceId == null) {
            workspaceId = chatWorkspace.findWorkspaceForChat(chatId, principal.userId())
                    .orElseThrow(() -> DomainException.notFound("Chat not found"));
        }
        Principal scoped = principal.withWorkspace(workspaceId);
        tenantContext.activate(scoped);
        ChatAccess access = chatAccess.requireActiveChat(workspaceId, chatId, principal.userId());
        return new PluginChatContext(workspaceId, access.securityMode(), access.memberRole());
    }
}
