package ru.krug.backend.plugin.api.mapper;

import java.util.List;

import ru.krug.backend.plugin.api.dto.PollListResponse;
import ru.krug.backend.plugin.api.dto.PollOptionResponse;
import ru.krug.backend.plugin.api.dto.PollResponse;
import ru.krug.backend.plugin.api.dto.TaskListResponse;
import ru.krug.backend.plugin.api.dto.TaskResponse;
import ru.krug.backend.plugin.api.dto.TranslationResponse;
import ru.krug.backend.plugin.application.model.PollOptionView;
import ru.krug.backend.plugin.application.model.PollView;
import ru.krug.backend.plugin.application.model.TaskView;
import ru.krug.backend.plugin.application.model.TranslationView;

/** Application read models -> plugin-action API DTOs. No domain/persistence imports. */
public final class PluginActionsApiMapper {

    private PluginActionsApiMapper() {
    }

    public static PollListResponse toPollListResponse(List<PollView> polls) {
        List<PollResponse> items = polls.stream().map(PluginActionsApiMapper::toPollResponse).toList();
        return new PollListResponse(items);
    }

    public static PollResponse toPollResponse(PollView poll) {
        List<PollOptionResponse> options = poll.options().stream()
                .map(PluginActionsApiMapper::toResponse)
                .toList();
        return new PollResponse(poll.id(), poll.question(), options, poll.creatorId(),
                poll.closed(), poll.closedAt(), poll.createdAt(), poll.myOptionId(),
                poll.totalVotes());
    }

    private static PollOptionResponse toResponse(PollOptionView option) {
        return new PollOptionResponse(option.id(), option.text(), option.position(),
                option.votes());
    }

    public static TaskListResponse toTaskListResponse(List<TaskView> tasks) {
        List<TaskResponse> items = tasks.stream().map(PluginActionsApiMapper::toTaskResponse).toList();
        return new TaskListResponse(items);
    }

    public static TaskResponse toTaskResponse(TaskView task) {
        return new TaskResponse(task.id(), task.title(), task.creatorId(), task.assigneeId(),
                task.dueAt(), task.done(), task.completedBy(), task.completedAt(),
                task.createdAt());
    }

    public static TranslationResponse toTranslationResponse(TranslationView translation) {
        return new TranslationResponse(translation.text());
    }
}
