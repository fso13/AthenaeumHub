package ru.krug.backend.plugin.application.port;

import java.util.UUID;

import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.plugin.application.model.PluginChatContext;

/**
 * Cross-context access gate for the plugin slice. Implemented in infrastructure over the
 * published chat ports: resolves the workspace for Keycloak principals, activates the
 * tenant GUCs and verifies ACTIVE chat membership.
 */
public interface PluginChatAccessPort {

    /**
     * @throws ru.krug.backend.shared.error.DomainException 403 without workspace
     *         membership, 404 when the chat is unknown/deleted/foreign (existence hidden).
     */
    PluginChatContext requireActiveChat(Principal principal, UUID chatId);
}
