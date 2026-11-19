package ru.krug.backend.plugin.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.plugin.domain.model.ChatPlugin;
import ru.krug.backend.plugin.domain.repository.ChatPluginRepository;

/**
 * Native adapter for {@code chat.chat_plugins}. RLS is forced on the table, so every
 * query runs under the tenant GUCs activated by the access adapter. The upsert uses a
 * conditional {@code DO UPDATE ... WHERE IS DISTINCT FROM} plus {@code RETURNING}: a
 * repeated request with the same value changes no row and returns an empty result, which
 * the use case uses to skip the duplicate audit event.
 */
@Repository
public class ChatPluginRepositoryAdapter implements ChatPluginRepository {

    private final EntityManager entityManager;

    public ChatPluginRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public List<ChatPlugin> findByChat(UUID workspaceId, UUID chatId) {
        List<?> rows = entityManager.createNativeQuery("""
                        SELECT plugin_id, enabled
                          FROM chat.chat_plugins
                         WHERE workspace_id = ?1 AND chat_id = ?2
                         ORDER BY plugin_id
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, chatId)
                .getResultList();
        return rows.stream().map(row -> {
            Object[] values = (Object[]) row;
            return new ChatPlugin((String) values[0], Boolean.TRUE.equals(values[1]));
        }).toList();
    }

    @Override
    public boolean setEnabled(UUID workspaceId, UUID chatId, String pluginId, boolean enabled,
                              UUID actorId, Instant at) {
        List<?> changed = entityManager.createNativeQuery("""
                        INSERT INTO chat.chat_plugins
                               (workspace_id, chat_id, plugin_id, enabled, updated_by, updated_at)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                        ON CONFLICT (chat_id, plugin_id) DO UPDATE
                           SET enabled = EXCLUDED.enabled,
                               updated_by = EXCLUDED.updated_by,
                               updated_at = EXCLUDED.updated_at
                         WHERE chat.chat_plugins.enabled IS DISTINCT FROM EXCLUDED.enabled
                        RETURNING plugin_id
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, chatId)
                .setParameter(3, pluginId)
                .setParameter(4, enabled)
                .setParameter(5, actorId)
                .setParameter(6, Timestamp.from(at))
                .getResultList();
        return !changed.isEmpty();
    }
}
