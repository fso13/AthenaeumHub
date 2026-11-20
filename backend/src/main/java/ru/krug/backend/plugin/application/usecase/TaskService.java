package ru.krug.backend.plugin.application.usecase;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.ops.application.model.IdempotencyReservation;
import ru.krug.backend.ops.application.port.IdempotencyPort;
import ru.krug.backend.plugin.application.model.PluginChatContext;
import ru.krug.backend.plugin.application.model.PluginMessageRef;
import ru.krug.backend.plugin.application.model.TaskCreateResult;
import ru.krug.backend.plugin.application.model.TaskView;
import ru.krug.backend.plugin.application.port.PluginChatAccessPort;
import ru.krug.backend.plugin.application.port.PluginMessagePort;
import ru.krug.backend.plugin.domain.model.ChatTask;
import ru.krug.backend.plugin.domain.repository.ChatTaskRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.RequestCanonicalizer;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Tasks plugin actions ({@code #76}). Any ACTIVE member of a chat with the {@code tasks}
 * plugin enabled may create a task. Completion/reopening is limited to the creator, the
 * assignee or a chat OWNER/ADMIN. The assignee is taken from the request but must be an
 * ACTIVE member of the same chat — arbitrary user ids are rejected with 422.
 *
 * <p>Audit metadata is ids-only; the title is never written.</p>
 */
@Service
public class TaskService {

    static final String PLUGIN_ID = "tasks";
    static final String ACTION_CREATED = "chat.task.created";
    static final String ACTION_COMPLETED = "chat.task.completed";
    static final String ACTION_REOPENED = "chat.task.reopened";
    static final String CREATE_IDEMPOTENCY_SCOPE = "POST /chats/{chatId}/tasks";
    private static final int LIST_LIMIT = 100;

    private final PluginActionGate gate;
    private final PluginChatAccessPort access;
    private final ChatTaskRepository repository;
    private final AuditPort audit;
    private final ClockPort clock;
    private final IdempotencyPort idempotency;
    private final RequestCanonicalizer canonicalizer;
    private final PluginMessagePort messages;

    public TaskService(PluginActionGate gate, PluginChatAccessPort access,
                       ChatTaskRepository repository, AuditPort audit, ClockPort clock,
                       IdempotencyPort idempotency, RequestCanonicalizer canonicalizer,
                       PluginMessagePort messages) {
        this.gate = gate;
        this.access = access;
        this.repository = repository;
        this.audit = audit;
        this.clock = clock;
        this.idempotency = idempotency;
        this.canonicalizer = canonicalizer;
        this.messages = messages;
    }

    @Transactional(readOnly = true)
    public List<TaskView> list(Principal principal, UUID chatId) {
        PluginChatContext context = gate.requireEnabled(principal, chatId, PLUGIN_ID);
        return repository.findByChat(context.workspaceId(), chatId, LIST_LIMIT).stream()
                .map(TaskView::from)
                .toList();
    }

    @Transactional
    public TaskCreateResult create(Principal principal, UUID chatId, String title,
                                   UUID assigneeId, Instant dueAt, UUID idempotencyKey) {
        PluginChatContext context = gate.requireEnabled(principal, chatId, PLUGIN_ID);
        if (assigneeId != null && !access.isActiveChatMember(context.workspaceId(), chatId,
                assigneeId)) {
            throw DomainException.unprocessable(ErrorCode.TASK_ASSIGNEE_INVALID,
                    "Assignee must be an active member of this chat",
                    Map.of("field", "assignee_id"));
        }
        ChatTask task = ChatTask.create(UUID.randomUUID(), context.workspaceId(), chatId,
                principal.userId(), assigneeId, title, dueAt, clock.now());
        Principal scoped = principal.withWorkspace(context.workspaceId());
        byte[] requestHash = requestHash(chatId, task);
        IdempotencyReservation reservation = idempotency.reserve(scoped,
                CREATE_IDEMPOTENCY_SCOPE, idempotencyKey.toString(), requestHash);
        if (reservation.replay()) {
            return replay(scoped, chatId, reservation);
        }
        repository.create(task);
        // #95: entity + TASK timeline message + audit + idempotency commit atomically.
        UUID messageId = messages.createTaskMessage(scoped, chatId, task.id());
        audit.append(new AuditRecord(context.workspaceId(), principal.userId(),
                ACTION_CREATED, "task", task.id(), principal.requestId(), Map.of(),
                clock.now()));
        idempotency.complete(scoped, CREATE_IDEMPOTENCY_SCOPE, idempotencyKey.toString(),
                requestHash, 201, messageId);
        return new TaskCreateResult(TaskView.from(task), messageId, false);
    }

    private TaskCreateResult replay(Principal principal, UUID chatId,
                                    IdempotencyReservation reservation) {
        PluginMessageRef ref = messages.findMessage(principal, reservation.resourceId())
                .orElseThrow(() -> DomainException.conflict(ErrorCode.CONFLICT,
                        "Idempotent replay target is no longer available", Map.of()));
        if (!chatId.equals(ref.chatId()) || ref.taskId() == null) {
            throw DomainException.conflict(ErrorCode.CONFLICT,
                    "Idempotent replay target is not a task of this chat", Map.of());
        }
        ChatTask replayed = repository.findById(principal.workspaceId(), chatId, ref.taskId())
                .orElseThrow(() -> DomainException.conflict(ErrorCode.CONFLICT,
                        "Idempotent replay target is no longer available", Map.of()));
        return new TaskCreateResult(TaskView.from(replayed), ref.messageId(), true);
    }

    private byte[] requestHash(UUID chatId, ChatTask task) {
        return canonicalizer.sha256("POST\n/api/v1/chats/" + chatId + "/tasks\n"
                + task.title() + "\n" + (task.assigneeId() == null ? "" : task.assigneeId())
                + "\n" + (task.dueAt() == null ? "" : task.dueAt()));
    }

    @Transactional
    public TaskView updateDone(Principal principal, UUID chatId, UUID taskId, boolean done) {
        PluginChatContext context = gate.requireEnabled(principal, chatId, PLUGIN_ID);
        ChatTask task = requireTask(context, chatId, taskId);
        if (!task.canChangeDone(principal.userId(), context.memberRole())) {
            throw DomainException.forbidden(
                    "Only the creator, assignee or a chat OWNER/ADMIN can change a task");
        }
        if (task.done() == done) {
            return TaskView.from(task);
        }
        ChatTask updated = repository.updateDone(context.workspaceId(), chatId, taskId, done,
                        principal.userId(), clock.now())
                .orElse(null);
        if (updated == null) {
            // Empty means another request already reached the requested state (it emitted
            // the audit) or the row disappeared; re-read and do not duplicate the event.
            return TaskView.from(requireTask(context, chatId, taskId));
        }
        audit.append(new AuditRecord(context.workspaceId(), principal.userId(),
                done ? ACTION_COMPLETED : ACTION_REOPENED, "task", taskId,
                principal.requestId(), Map.of(), clock.now()));
        return TaskView.from(updated);
    }

    private ChatTask requireTask(PluginChatContext context, UUID chatId, UUID taskId) {
        return repository.findById(context.workspaceId(), chatId, taskId)
                .orElseThrow(() -> DomainException.notFound("Task not found"));
    }
}
