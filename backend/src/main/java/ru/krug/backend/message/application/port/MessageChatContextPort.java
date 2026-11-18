package ru.krug.backend.message.application.port;

import java.util.UUID;

/**
 * E2EE send needs the chat type and the other DIRECT participant. The peer id is derived
 * from {@code chat_members} (it is not stored on the chat); E2EE GROUP has no fan-out in
 * E7 and is rejected before validation.
 */
public interface MessageChatContextPort {

    ChatContext require(UUID workspaceId, UUID chatId, UUID userId);

    record ChatContext(String type, UUID peerUserId) {
    }
}
