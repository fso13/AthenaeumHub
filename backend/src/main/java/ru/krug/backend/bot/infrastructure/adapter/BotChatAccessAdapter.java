package ru.krug.backend.bot.infrastructure.adapter;

import java.util.UUID;

import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.bot.application.model.BotChatAccess;
import ru.krug.backend.bot.application.port.BotChatAccessPort;
import ru.krug.backend.chat.application.model.ChatAccess;
import ru.krug.backend.chat.application.port.ChatAccessPort;
import ru.krug.backend.chat.application.port.ChatWorkspacePort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;

/**
 * User-scoped chat gate for bot installation. Mirrors the plugin/sticker adapters: the
 * workspace is resolved for Keycloak principals (dev tokens already carry it), the tenant GUC
 * is activated and ACTIVE chat membership is verified through the published chat port.
 */
@Component
public class BotChatAccessAdapter implements BotChatAccessPort {

    private final TenantContext tenantContext;
    private final ChatWorkspacePort chatWorkspace;
    private final ChatAccessPort chatAccess;

    public BotChatAccessAdapter(TenantContext tenantContext, ChatWorkspacePort chatWorkspace,
                                ChatAccessPort chatAccess) {
        this.tenantContext = tenantContext;
        this.chatWorkspace = chatWorkspace;
        this.chatAccess = chatAccess;
    }

    @Override
    @Transactional
    public BotChatAccess requireActiveChat(Principal principal, UUID chatId) {
        UUID workspaceId = principal.workspaceId();
        if (workspaceId == null) {
            workspaceId = chatWorkspace.findWorkspaceForChat(chatId, principal.userId())
                    .orElseThrow(() -> DomainException.notFound("Chat not found"));
        }
        tenantContext.activate(principal.withWorkspace(workspaceId));
        ChatAccess access = chatAccess.requireActiveChat(workspaceId, chatId,
                principal.userId());
        return new BotChatAccess(workspaceId, access.securityMode(), access.memberRole());
    }
}
