package ru.krug.backend.plugin.domain.repository;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import ru.krug.backend.plugin.domain.model.ChatPlugin;

/**
 * Per-chat toggle persistence. The repository never executes plugin code or reads chat
 * content; it only stores the state shown by the dashboard switches.
 */
public interface ChatPluginRepository {

    List<ChatPlugin> findByChat(UUID workspaceId, UUID chatId);

    /**
     * Effective per-chat toggle. A missing row means {@code false}; callers must still
     * apply {@code PluginAvailabilityPolicy} (mode/kill switch) before acting.
     */
    boolean isEnabled(UUID workspaceId, UUID chatId, String pluginId);

    /**
     * Idempotent upsert.
     *
     * @return {@code true} only when the stored value actually changed (insert or
     *         enabled flip); a repeated request with the same value returns {@code false}
     *         and does not touch {@code updated_by}/{@code updated_at}.
     */
    boolean setEnabled(UUID workspaceId, UUID chatId, String pluginId, boolean enabled,
                       UUID actorId, Instant at);
}
