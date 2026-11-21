package ru.krug.backend.bot.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * Per-chat bot installation. A row exists only while the bot is installed; {@code enabled}
 * is the effective delivery flag (an installer may disable without removing the row in a
 * future slice). Sending is allowed only when the row exists and is enabled.
 */
public final class ChatBot {

    private final UUID workspaceId;
    private final UUID chatId;
    private final UUID botId;
    private final boolean enabled;
    private final UUID installedBy;
    private final Instant installedAt;
    private final Instant updatedAt;

    private ChatBot(UUID workspaceId, UUID chatId, UUID botId, boolean enabled,
                    UUID installedBy, Instant installedAt, Instant updatedAt) {
        this.workspaceId = Objects.requireNonNull(workspaceId, "workspaceId");
        this.chatId = Objects.requireNonNull(chatId, "chatId");
        this.botId = Objects.requireNonNull(botId, "botId");
        this.enabled = enabled;
        this.installedBy = Objects.requireNonNull(installedBy, "installedBy");
        this.installedAt = Objects.requireNonNull(installedAt, "installedAt");
        this.updatedAt = Objects.requireNonNull(updatedAt, "updatedAt");
    }

    public static ChatBot installed(UUID workspaceId, UUID chatId, UUID botId, UUID installedBy,
                                    Instant now) {
        return new ChatBot(workspaceId, chatId, botId, true, installedBy, now, now);
    }

    public static ChatBot reconstitute(UUID workspaceId, UUID chatId, UUID botId, boolean enabled,
                                       UUID installedBy, Instant installedAt, Instant updatedAt) {
        return new ChatBot(workspaceId, chatId, botId, enabled, installedBy, installedAt,
                updatedAt);
    }

    public UUID workspaceId() {
        return workspaceId;
    }

    public UUID chatId() {
        return chatId;
    }

    public UUID botId() {
        return botId;
    }

    public boolean enabled() {
        return enabled;
    }

    public UUID installedBy() {
        return installedBy;
    }

    public Instant installedAt() {
        return installedAt;
    }

    public Instant updatedAt() {
        return updatedAt;
    }
}
