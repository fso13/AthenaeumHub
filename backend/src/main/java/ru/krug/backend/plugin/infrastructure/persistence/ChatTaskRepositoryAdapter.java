package ru.krug.backend.plugin.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.plugin.domain.model.ChatTask;
import ru.krug.backend.plugin.domain.repository.ChatTaskRepository;

/**
 * Native adapter for {@code plugin.tasks}. Every statement is scoped by workspace/chat and
 * RLS; completion is a single conditional UPDATE so two concurrent requests cannot both
 * emit an effective change.
 */
@Repository
public class ChatTaskRepositoryAdapter implements ChatTaskRepository {

    private static final String COLUMNS = """
            id, workspace_id, chat_id, creator_id, assignee_id, title, due_at,
            done, completed_by, completed_at, created_at
            """;

    private final EntityManager entityManager;

    public ChatTaskRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public ChatTask create(ChatTask task) {
        entityManager.createNativeQuery("""
                        INSERT INTO plugin.tasks
                               (id, workspace_id, chat_id, creator_id, assignee_id, title,
                                due_at, done, completed_by, completed_at, created_at)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, false, NULL, NULL, ?8)
                        """)
                .setParameter(1, task.id())
                .setParameter(2, task.workspaceId())
                .setParameter(3, task.chatId())
                .setParameter(4, task.creatorId())
                .setParameter(5, task.assigneeId())
                .setParameter(6, task.title())
                .setParameter(7, task.dueAt() == null ? null : Timestamp.from(task.dueAt()))
                .setParameter(8, Timestamp.from(task.createdAt()))
                .executeUpdate();
        return task;
    }

    @Override
    public Optional<ChatTask> findById(UUID workspaceId, UUID chatId, UUID taskId) {
        List<?> rows = entityManager.createNativeQuery("""
                        SELECT %s
                          FROM plugin.tasks
                         WHERE workspace_id = ?1 AND chat_id = ?2 AND id = ?3
                        """.formatted(COLUMNS))
                .setParameter(1, workspaceId)
                .setParameter(2, chatId)
                .setParameter(3, taskId)
                .getResultList();
        return rows.stream().map(row -> toTask((Object[]) row)).findFirst();
    }

    @Override
    public List<ChatTask> findByChat(UUID workspaceId, UUID chatId, int limit) {
        List<?> rows = entityManager.createNativeQuery("""
                        SELECT %s
                          FROM plugin.tasks
                         WHERE workspace_id = ?1 AND chat_id = ?2
                         ORDER BY done ASC, created_at DESC, id DESC
                         LIMIT ?3
                        """.formatted(COLUMNS))
                .setParameter(1, workspaceId)
                .setParameter(2, chatId)
                .setParameter(3, limit)
                .getResultList();
        return rows.stream().map(row -> toTask((Object[]) row)).toList();
    }

    @Override
    public Optional<ChatTask> updateDone(UUID workspaceId, UUID chatId, UUID taskId,
                                         boolean done, UUID actorId, Instant at) {
        List<?> changed = entityManager.createNativeQuery("""
                        UPDATE plugin.tasks
                           SET done = ?1,
                               completed_by = ?2,
                               completed_at = ?3,
                               updated_at = ?4
                         WHERE workspace_id = ?5 AND chat_id = ?6 AND id = ?7
                           AND done IS DISTINCT FROM ?1
                        RETURNING id
                        """)
                .setParameter(1, done)
                .setParameter(2, done ? actorId : null)
                .setParameter(3, done ? Timestamp.from(at) : null)
                .setParameter(4, Timestamp.from(at))
                .setParameter(5, workspaceId)
                .setParameter(6, chatId)
                .setParameter(7, taskId)
                .getResultList();
        if (changed.isEmpty()) {
            return Optional.empty();
        }
        return findById(workspaceId, chatId, taskId);
    }

    private static ChatTask toTask(Object[] values) {
        return ChatTask.reconstitute(
                (UUID) values[0],
                (UUID) values[1],
                (UUID) values[2],
                (UUID) values[3],
                (UUID) values[4],
                (String) values[5],
                instant(values[6]),
                Boolean.TRUE.equals(values[7]),
                (UUID) values[8],
                instant(values[9]),
                instant(values[10]));
    }

    private static Instant instant(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof Timestamp timestamp) {
            return timestamp.toInstant();
        }
        if (value instanceof OffsetDateTime offsetDateTime) {
            return offsetDateTime.toInstant();
        }
        return (Instant) value;
    }
}
