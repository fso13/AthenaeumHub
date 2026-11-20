package ru.krug.backend.plugin.application.usecase;

import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.plugin.application.model.PollView;
import ru.krug.backend.plugin.application.model.TaskView;
import ru.krug.backend.plugin.domain.repository.ChatTaskRepository;
import ru.krug.backend.plugin.domain.repository.PollRepository;

/**
 * Internal cross-context read used by the message projection (#95). The caller is the
 * message query/replay layer, which has already verified ACTIVE chat membership and
 * activated the tenant context; therefore this service deliberately does not re-run the
 * plugin action gate (doing so would recurse through the message writer). It exposes only
 * workspace/chat-scoped, viewer-relative read models and returns no content for unknown or
 * foreign ids.
 */
@Service
public class PluginContentQueryService {

    private final PollRepository polls;
    private final ChatTaskRepository tasks;

    public PluginContentQueryService(PollRepository polls, ChatTaskRepository tasks) {
        this.polls = polls;
        this.tasks = tasks;
    }

    @Transactional(readOnly = true)
    public Map<UUID, PollView> findPolls(UUID workspaceId, UUID chatId,
                                         Collection<UUID> pollIds, UUID viewerId) {
        if (pollIds == null || pollIds.isEmpty()) {
            return Map.of();
        }
        Map<UUID, PollView> result = new LinkedHashMap<>();
        for (var poll : polls.findByIds(workspaceId, chatId, pollIds, viewerId)) {
            result.put(poll.id(), PollView.from(poll));
        }
        return result;
    }

    @Transactional(readOnly = true)
    public Map<UUID, TaskView> findTasks(UUID workspaceId, UUID chatId,
                                         Collection<UUID> taskIds) {
        if (taskIds == null || taskIds.isEmpty()) {
            return Map.of();
        }
        Map<UUID, TaskView> result = new LinkedHashMap<>();
        for (var task : tasks.findByIds(workspaceId, chatId, taskIds)) {
            result.put(task.id(), TaskView.from(task));
        }
        return result;
    }
}
