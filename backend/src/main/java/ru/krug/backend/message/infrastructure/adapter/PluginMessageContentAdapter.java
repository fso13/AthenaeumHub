package ru.krug.backend.message.infrastructure.adapter;

import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Component;

import ru.krug.backend.message.application.model.EmbeddedPollOptionView;
import ru.krug.backend.message.application.model.EmbeddedPollView;
import ru.krug.backend.message.application.model.EmbeddedTaskView;
import ru.krug.backend.message.application.port.MessagePluginContentPort;
import ru.krug.backend.plugin.application.model.PollView;
import ru.krug.backend.plugin.application.model.TaskView;
import ru.krug.backend.plugin.application.usecase.PluginContentQueryService;

/**
 * Message-side adapter over the plugin read projections (#95). It is the only place where
 * the message context touches plugin application models; the message application and domain
 * see {@link MessagePluginContentPort} and primitive view records only.
 */
@Component
public class PluginMessageContentAdapter implements MessagePluginContentPort {

    private final PluginContentQueryService queryService;

    public PluginMessageContentAdapter(PluginContentQueryService queryService) {
        this.queryService = queryService;
    }

    @Override
    public Map<UUID, EmbeddedPollView> findPolls(UUID workspaceId, UUID chatId,
                                                  Collection<UUID> pollIds, UUID viewerId) {
        Map<UUID, EmbeddedPollView> result = new LinkedHashMap<>();
        for (PollView poll : queryService.findPolls(workspaceId, chatId,
                pollIds, viewerId).values()) {
            result.put(poll.id(), new EmbeddedPollView(poll.id(), poll.question(),
                    poll.options().stream()
                            .map(option -> new EmbeddedPollOptionView(option.id(),
                                    option.text(), option.position(), option.votes()))
                            .toList(),
                    poll.creatorId(), poll.closed(), poll.closedAt(), poll.createdAt(),
                    poll.myOptionId(), poll.totalVotes()));
        }
        return result;
    }

    @Override
    public Map<UUID, EmbeddedTaskView> findTasks(UUID workspaceId, UUID chatId,
                                                  Collection<UUID> taskIds, UUID viewerId) {
        Map<UUID, EmbeddedTaskView> result = new LinkedHashMap<>();
        for (TaskView task : queryService.findTasks(workspaceId, chatId, taskIds).values()) {
            result.put(task.id(), new EmbeddedTaskView(task.id(), task.title(),
                    task.creatorId(), task.assigneeId(), task.dueAt(), task.done(),
                    task.completedBy(), task.completedAt(), task.createdAt()));
        }
        return result;
    }
}
