package ru.krug.backend.bot.domain.repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.bot.domain.model.ChatBot;

/**
 * Persistence port for per-chat bot installations. {@code find/list} never cross the tenant
 * boundary; the caller must have activated the workspace context.
 */
public interface ChatBotRepository {

    Optional<ChatBot> find(UUID workspaceId, UUID chatId, UUID botId);

    List<ChatBot> findByChat(UUID workspaceId, UUID chatId);

    /**
     * Idempotent install: inserts an enabled row or leaves an existing row untouched.
     *
     * @return {@code true} when a new row was inserted (audit only on a real change)
     */
    boolean install(UUID workspaceId, UUID chatId, UUID botId, UUID installedBy, Instant now);

    /**
     * Idempotent uninstall.
     *
     * @return {@code true} when a row was removed
     */
    boolean uninstall(UUID workspaceId, UUID chatId, UUID botId);
}
