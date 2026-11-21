package ru.krug.backend.plugin.infrastructure.persistence;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.plugin.domain.repository.MusicRoomRepository;

/**
 * Native adapter for {@code chat.plugin_rooms} (#94). The table is FORCE-RLS scoped to the
 * tenant GUCs activated by the open/list use cases; the PK is the database backstop for the
 * "one music room per workspace" invariant.
 */
@Repository
public class MusicRoomRepositoryAdapter implements MusicRoomRepository {

    private final EntityManager entityManager;

    public MusicRoomRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public void lock(UUID workspaceId, String pluginId) {
        entityManager.createNativeQuery("""
                        SELECT pg_advisory_xact_lock(
                                   hashtextextended(
                                       'plugin.room|' || ?1 || '|' || ?2, 0))
                        """)
                .setParameter(1, workspaceId.toString())
                .setParameter(2, pluginId)
                .getSingleResult();
    }

    @Override
    public Optional<UUID> findChatId(UUID workspaceId, String pluginId) {
        List<?> rows = entityManager.createNativeQuery("""
                        SELECT chat_id
                          FROM chat.plugin_rooms
                         WHERE workspace_id = ?1
                           AND plugin_id = ?2
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, pluginId)
                .getResultList();
        return rows.stream().findFirst()
                .map(value -> value instanceof UUID uuid ? uuid
                        : UUID.fromString(value.toString()));
    }

    @Override
    public void link(UUID workspaceId, String pluginId, UUID chatId, UUID createdBy) {
        entityManager.createNativeQuery("""
                        INSERT INTO chat.plugin_rooms
                               (workspace_id, plugin_id, chat_id, created_by)
                        VALUES (?1, ?2, ?3, ?4)
                        ON CONFLICT (workspace_id, plugin_id) DO UPDATE
                           SET chat_id = EXCLUDED.chat_id,
                               created_by = EXCLUDED.created_by,
                               created_at = now()
                         WHERE chat.plugin_rooms.chat_id IS DISTINCT FROM EXCLUDED.chat_id
                        """)
                .setParameter(1, workspaceId)
                .setParameter(2, pluginId)
                .setParameter(3, chatId)
                .setParameter(4, createdBy)
                .executeUpdate();
    }
}
