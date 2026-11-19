package ru.krug.backend.plugin.domain.repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.plugin.domain.model.ChatTask;

/**
 * Task persistence. Queries are workspace/chat scoped and run under forced RLS. There is
 * no delete operation in this slice.
 */
public interface ChatTaskRepository {

    ChatTask create(ChatTask task);

    Optional<ChatTask> findById(UUID workspaceId, UUID chatId, UUID taskId);

    /** Open tasks first, then completed; newest first inside each group. */
    List<ChatTask> findByChat(UUID workspaceId, UUID chatId, int limit);

    /**
     * Conditional completion update. Returns the updated task, or empty when the task does
     * not belong to the workspace/chat or the state already equals {@code done}
     * (idempotent; the caller skips the second audit).
     */
    Optional<ChatTask> updateDone(UUID workspaceId, UUID chatId, UUID taskId, boolean done,
                                  UUID actorId, Instant at);
}
