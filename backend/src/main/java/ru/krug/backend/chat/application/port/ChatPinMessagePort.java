package ru.krug.backend.chat.application.port;

import java.util.Collection;
import java.util.Set;
import java.util.UUID;

/**
 * Cross-context check that a pinned message is accessible (P0-2 / #80). Implemented by the
 * message context, which owns {@code message.messages}; the chat context never reads the
 * message body or its ciphertext.
 */
public interface ChatPinMessagePort {

    /** True when the message exists in this chat/workspace and is not deleted for all. */
    boolean isAccessibleMessage(UUID workspaceId, UUID chatId, UUID messageId);

    /**
     * Filters the given ids to the messages that still exist in this chat and are not
     * deleted; preserves no order and never exposes content.
     */
    Set<UUID> filterAccessible(UUID workspaceId, UUID chatId, Collection<UUID> messageIds);
}
