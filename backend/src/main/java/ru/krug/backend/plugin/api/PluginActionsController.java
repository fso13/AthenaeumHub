package ru.krug.backend.plugin.api;

import java.util.UUID;

import jakarta.validation.Valid;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.plugin.api.dto.PollCloseRequest;
import ru.krug.backend.plugin.api.dto.PollCreateRequest;
import ru.krug.backend.plugin.api.dto.PollListResponse;
import ru.krug.backend.plugin.api.dto.PollResponse;
import ru.krug.backend.plugin.api.dto.PollVoteRequest;
import ru.krug.backend.plugin.api.dto.TaskCreateRequest;
import ru.krug.backend.plugin.api.dto.TaskListResponse;
import ru.krug.backend.plugin.api.dto.TaskResponse;
import ru.krug.backend.plugin.api.dto.TaskUpdateRequest;
import ru.krug.backend.plugin.api.dto.TranslationRequest;
import ru.krug.backend.plugin.api.dto.TranslationResponse;
import ru.krug.backend.plugin.api.mapper.PluginActionsApiMapper;
import ru.krug.backend.plugin.application.model.PollCreateResult;
import ru.krug.backend.plugin.application.model.TaskCreateResult;
import ru.krug.backend.plugin.application.usecase.PollService;
import ru.krug.backend.plugin.application.usecase.TaskService;
import ru.krug.backend.plugin.application.usecase.TranslateMessageService;
import ru.krug.backend.shared.api.RequestHeaders;
import ru.krug.backend.shared.application.model.Principal;

/**
 * D1.1 (#76) plugin actions. Every method is gated by an ACTIVE chat membership and the
 * per-chat plugin toggle; no plugin code is executed and translation is bounded/optional.
 */
@RestController
@RequestMapping("/api/v1")
public class PluginActionsController {

    private final PollService polls;
    private final TaskService tasks;
    private final TranslateMessageService translate;

    public PluginActionsController(PollService polls, TaskService tasks,
                                   TranslateMessageService translate) {
        this.polls = polls;
        this.tasks = tasks;
        this.translate = translate;
    }

    @GetMapping("/chats/{chatId}/polls")
    public PollListResponse listPolls(@PathVariable UUID chatId, Principal principal) {
        return PluginActionsApiMapper.toPollListResponse(polls.list(principal, chatId));
    }

    @PostMapping("/chats/{chatId}/polls")
    public ResponseEntity<PollResponse> createPoll(
            @PathVariable UUID chatId,
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @Valid @RequestBody PollCreateRequest request,
            Principal principal) {
        PollCreateResult result = polls.create(principal, chatId, request.question(),
                request.options(), idempotencyKey(idempotencyKey));
        ResponseEntity.BodyBuilder builder = ResponseEntity.status(HttpStatus.CREATED);
        if (result.replay()) {
            builder.header("Idempotent-Replay", "true");
        }
        return builder.body(PluginActionsApiMapper.toPollCreatedResponse(result.poll(),
                result.messageId()));
    }

    @PostMapping("/chats/{chatId}/polls/{pollId}/votes")
    public PollResponse vote(@PathVariable UUID chatId, @PathVariable UUID pollId,
                             @Valid @RequestBody PollVoteRequest request,
                             Principal principal) {
        return PluginActionsApiMapper.toPollResponse(
                polls.vote(principal, chatId, pollId, request.optionId()));
    }

    @PatchMapping("/chats/{chatId}/polls/{pollId}")
    public PollResponse closePoll(@PathVariable UUID chatId, @PathVariable UUID pollId,
                                  @Valid @RequestBody PollCloseRequest request,
                                  Principal principal) {
        return PluginActionsApiMapper.toPollResponse(
                polls.close(principal, chatId, pollId, request.closed()));
    }

    @GetMapping("/chats/{chatId}/tasks")
    public TaskListResponse listTasks(@PathVariable UUID chatId, Principal principal) {
        return PluginActionsApiMapper.toTaskListResponse(tasks.list(principal, chatId));
    }

    @PostMapping("/chats/{chatId}/tasks")
    public ResponseEntity<TaskResponse> createTask(
            @PathVariable UUID chatId,
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey,
            @Valid @RequestBody TaskCreateRequest request,
            Principal principal) {
        TaskCreateResult result = tasks.create(principal, chatId, request.title(),
                request.assigneeId(), request.dueAt(), idempotencyKey(idempotencyKey));
        ResponseEntity.BodyBuilder builder = ResponseEntity.status(HttpStatus.CREATED);
        if (result.replay()) {
            builder.header("Idempotent-Replay", "true");
        }
        return builder.body(PluginActionsApiMapper.toTaskCreatedResponse(result.task(),
                result.messageId()));
    }

    @PatchMapping("/chats/{chatId}/tasks/{taskId}")
    public TaskResponse updateTask(@PathVariable UUID chatId, @PathVariable UUID taskId,
                                   @Valid @RequestBody TaskUpdateRequest request,
                                   Principal principal) {
        return PluginActionsApiMapper.toTaskResponse(
                tasks.updateDone(principal, chatId, taskId, request.done()));
    }

    /**
     * #95: the key is optional for backward compatibility, but every create always runs
     * through the idempotency reservation (a missing header gets a fresh server-side key).
     * Supplying the header makes retries replay the original poll/task and its message.
     */
    private static UUID idempotencyKey(String header) {
        if (header == null || header.isBlank()) {
            return UUID.randomUUID();
        }
        return RequestHeaders.requireUuid(header, "Idempotency-Key");
    }

    @PostMapping("/chats/{chatId}/messages/{messageId}/translate")
    public TranslationResponse translateMessage(@PathVariable UUID chatId,
                                                @PathVariable UUID messageId,
                                                @Valid @RequestBody
                                                TranslationRequest request,
                                                Principal principal) {
        return PluginActionsApiMapper.toTranslationResponse(
                translate.translate(principal, chatId, messageId, request.target()));
    }
}
