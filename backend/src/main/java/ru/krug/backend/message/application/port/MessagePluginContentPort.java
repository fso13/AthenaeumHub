package ru.krug.backend.message.application.port;

import java.util.Collection;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.message.application.model.EmbeddedPollView;
import ru.krug.backend.message.application.model.EmbeddedTaskView;

/**
 * Cross-context read port used to embed the current poll/task state into POLL/TASK
 * messages. Implemented over the plugin read models; the message application never imports
 * plugin types. Callers are already inside a message-query transaction with an active
 * tenant context, so the implementation is a bounded batch read (no gate recursion).
 */
public interface MessagePluginContentPort {

    /** Keyed by poll id; missing/foreign ids are simply absent from the map. */
    Map<UUID, EmbeddedPollView> findPolls(UUID workspaceId, UUID chatId,
                                          Collection<UUID> pollIds, UUID viewerId);

    /** Keyed by task id; missing/foreign ids are simply absent from the map. */
    Map<UUID, EmbeddedTaskView> findTasks(UUID workspaceId, UUID chatId,
                                          Collection<UUID> taskIds, UUID viewerId);

    default Optional<EmbeddedPollView> findPoll(UUID workspaceId, UUID chatId, UUID pollId,
                                                 UUID viewerId) {
        if (pollId == null) {
            return Optional.empty();
        }
        return Optional.ofNullable(findPolls(workspaceId, chatId, java.util.List.of(pollId),
                viewerId).get(pollId));
    }

    default Optional<EmbeddedTaskView> findTask(UUID workspaceId, UUID chatId, UUID taskId,
                                                 UUID viewerId) {
        if (taskId == null) {
            return Optional.empty();
        }
        return Optional.ofNullable(findTasks(workspaceId, chatId, java.util.List.of(taskId),
                viewerId).get(taskId));
    }
}
