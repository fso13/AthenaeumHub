package ru.krug.backend.sticker.application.port;

import java.util.UUID;

import ru.krug.backend.shared.application.model.Principal;

/**
 * Cross-context access gate: resolves the chat workspace and verifies that the caller is
 * an ACTIVE member. Unknown/foreign chats are hidden (404) per OpenAPI.
 */
public interface StickerAccessPort {

    /** @return the chat's workspace id; the tenant GUCs are active on return. */
    UUID requireChatAccess(Principal principal, UUID chatId);
}
