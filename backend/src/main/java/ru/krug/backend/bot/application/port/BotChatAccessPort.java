package ru.krug.backend.bot.application.port;

import java.util.UUID;

import ru.krug.backend.bot.application.model.BotChatAccess;
import ru.krug.backend.shared.application.model.Principal;

/**
 * User-facing installation gate. Implemented over the published chat ports: the workspace is
 * resolved for Keycloak principals, the tenant GUC is activated and ACTIVE chat membership is
 * verified. Unknown/foreign/deleted chats stay a hidden 404.
 */
public interface BotChatAccessPort {

    BotChatAccess requireActiveChat(Principal principal, UUID chatId);
}
