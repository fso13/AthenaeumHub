package ru.krug.backend.message.application.event;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * In-process, post-commit signal that a managed message mentioned users (#83).
 *
 * <p>Only ids travel: no message text, no chat content. The MENTION fan-out listener resolves
 * preferences per recipient and creates a generic notification ("Вас упомянули"). E2EE
 * messages never publish this event (mentions are rejected before the message is stored).
 */
public record MessageMentionNotification(
        UUID workspaceId,
        UUID chatId,
        UUID messageId,
        UUID senderId,
        List<UUID> recipientIds,
        Instant createdAt) {

    public MessageMentionNotification {
        recipientIds = recipientIds == null ? List.of() : List.copyOf(recipientIds);
    }
}
