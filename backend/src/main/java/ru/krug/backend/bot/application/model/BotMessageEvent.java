package ru.krug.backend.bot.application.model;

import java.time.Instant;
import java.util.UUID;

/**
 * Cross-context port input: the committed-to-be message facts a bot webhook needs. It is
 * built by the message application layer, so the bot context never reads message tables and
 * the message context never imports bot domain types.
 */
public record BotMessageEvent(
        UUID workspaceId,
        UUID chatId,
        UUID messageId,
        long seq,
        UUID senderId,
        UUID senderBotId,
        String senderDisplayName,
        String type,
        String text,
        UUID replyToId,
        UUID threadRootId,
        boolean mentionAll,
        Instant createdAt) {

    public boolean isBotAuthored() {
        return senderBotId != null;
    }
}
