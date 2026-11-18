package ru.krug.backend.sticker.infrastructure.adapter;

import java.util.UUID;

import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.port.ChatAccessPort;
import ru.krug.backend.chat.application.port.ChatWorkspacePort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.sticker.application.port.StickerAccessPort;

/**
 * Sticker-side gate for {@code chat_id}: resolves the workspace for Keycloak principals
 * (dev tokens already carry it), activates RLS and verifies ACTIVE chat membership. A
 * foreign/unknown chat surfaces as 404 so its existence is not disclosed.
 */
@Component
public class StickerChatAccessAdapter implements StickerAccessPort {

    private final TenantContext tenantContext;
    private final ChatWorkspacePort chatWorkspace;
    private final ChatAccessPort chatAccess;

    public StickerChatAccessAdapter(TenantContext tenantContext,
                                    ChatWorkspacePort chatWorkspace,
                                    ChatAccessPort chatAccess) {
        this.tenantContext = tenantContext;
        this.chatWorkspace = chatWorkspace;
        this.chatAccess = chatAccess;
    }

    @Override
    @Transactional
    public UUID requireChatAccess(Principal principal, UUID chatId) {
        UUID workspaceId = principal.workspaceId();
        if (workspaceId == null) {
            workspaceId = chatWorkspace.findWorkspaceForChat(chatId, principal.userId())
                    .orElseThrow(() -> DomainException.notFound("Chat not found"));
        }
        Principal scoped = principal.withWorkspace(workspaceId);
        tenantContext.activate(scoped);
        chatAccess.requireActiveChat(workspaceId, chatId, principal.userId());
        return workspaceId;
    }
}
