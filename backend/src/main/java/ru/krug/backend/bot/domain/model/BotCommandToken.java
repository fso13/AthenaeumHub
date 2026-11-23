package ru.krug.backend.bot.domain.model;

import java.time.Instant;
import java.util.UUID;

/**
 * One-time response capability. Only the SHA-256 hash of the token is stored; the row is
 * consumed atomically in the same transaction as the bot message it authorises.
 */
public record BotCommandToken(
        UUID id,
        UUID workspaceId,
        UUID chatId,
        UUID botId,
        UUID invokedBy,
        String command,
        byte[] tokenHash,
        Instant expiresAt,
        Instant consumedAt,
        UUID responseMessageId,
        Instant createdAt) {

    public BotCommandToken {
        if (tokenHash != null) {
            tokenHash = tokenHash.clone();
        }
    }

    @Override
    public byte[] tokenHash() {
        return tokenHash == null ? null : tokenHash.clone();
    }

    public boolean isUsable(Instant now) {
        return consumedAt == null && expiresAt != null && expiresAt.isAfter(now);
    }
}
