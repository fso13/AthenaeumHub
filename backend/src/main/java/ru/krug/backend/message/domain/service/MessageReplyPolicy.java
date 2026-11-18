package ru.krug.backend.message.domain.service;

import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.shared.error.DomainException;

/**
 * Domain rule: reply_to_id must reference a message in the same chat (FR/UC-06).
 */
public final class MessageReplyPolicy {

    private MessageReplyPolicy() {
    }

    public static void ensureReplyTarget(UUID chatId, UUID replyToId, Optional<UUID> targetChatId) {
        if (replyToId == null) {
            return;
        }
        if (targetChatId.isEmpty() || !chatId.equals(targetChatId.get())) {
            throw DomainException.unprocessable(
                    "reply_to_id must reference a message in the same chat",
                    Map.of("field", "reply_to_id", "reason", "not_in_chat"));
        }
    }
}
