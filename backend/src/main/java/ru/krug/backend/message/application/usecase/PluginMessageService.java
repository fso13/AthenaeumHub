package ru.krug.backend.message.application.usecase;

import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.auth.application.port.UserProfilePort;
import ru.krug.backend.chat.application.port.ChatAccessPort;
import ru.krug.backend.chat.application.port.SeqAllocator;
import ru.krug.backend.message.application.event.MessageCreatedNotification;
import ru.krug.backend.message.application.model.EmbeddedPollView;
import ru.krug.backend.message.application.model.EmbeddedTaskView;
import ru.krug.backend.message.application.model.MessageView;
import ru.krug.backend.message.application.port.MessagePluginContentPort;
import ru.krug.backend.message.application.service.MessageEventPayload;
import ru.krug.backend.message.domain.event.MessageCreatedEvent;
import ru.krug.backend.message.domain.model.Message;
import ru.krug.backend.message.domain.repository.MessageRepository;
import ru.krug.backend.ops.application.model.OutboxEvent;
import ru.krug.backend.ops.application.port.OutboxPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * #95: creates the timeline projection of a poll/task. There is no client-facing message
 * create path for POLL/TASK: the plugin action service calls this writer in the same
 * transaction as the entity insert, and the whole result (entity + message + seq + outbox +
 * audit + idempotency completion) commits or rolls back atomically.
 *
 * <p>The row carries no body at all. Content is the referenced poll/task, resolved through
 * {@link MessagePluginContentPort} per viewer, so a vote or a task completion is reflected
 * by the next history/replay read without rewriting the message.</p>
 */
@Service
public class PluginMessageService {

    private final TenantContext tenantContext;
    private final ChatAccessPort chatAccess;
    private final MessageRepository messageRepository;
    private final SeqAllocator seqAllocator;
    private final UserProfilePort userProfile;
    private final OutboxPort outbox;
    private final ApplicationEventPublisher events;
    private final ClockPort clock;
    private final MessagePluginContentPort pluginContent;

    public PluginMessageService(TenantContext tenantContext, ChatAccessPort chatAccess,
                                MessageRepository messageRepository, SeqAllocator seqAllocator,
                                UserProfilePort userProfile, OutboxPort outbox,
                                ApplicationEventPublisher events, ClockPort clock,
                                MessagePluginContentPort pluginContent) {
        this.tenantContext = tenantContext;
        this.chatAccess = chatAccess;
        this.messageRepository = messageRepository;
        this.seqAllocator = seqAllocator;
        this.userProfile = userProfile;
        this.outbox = outbox;
        this.events = events;
        this.clock = clock;
        this.pluginContent = pluginContent;
    }

    @Transactional
    public MessageView createPollMessage(Principal principal, UUID chatId, UUID pollId) {
        return create(principal, chatId, Message.Type.POLL, pollId);
    }

    @Transactional
    public MessageView createTaskMessage(Principal principal, UUID chatId, UUID taskId) {
        return create(principal, chatId, Message.Type.TASK, taskId);
    }

    /**
     * Resolves the message that an idempotent create replay points at. Only the ids are
     * needed by the caller; the plugin action re-reads its own entity with a viewer-relative
     * projection under the same tenant context.
     */
    @Transactional(readOnly = true)
    public Optional<MessageView> find(Principal principal, UUID messageId) {
        if (principal.workspaceId() == null || messageId == null) {
            return Optional.empty();
        }
        tenantContext.activate(principal);
        return messageRepository.findById(principal.workspaceId(), messageId)
                .filter(Message::isPluginMessage)
                .map(MessageView::from);
    }

    private MessageView create(Principal principal, UUID chatId, Message.Type type, UUID refId) {
        if (principal.workspaceId() == null) {
            throw DomainException.forbidden("Workspace is required");
        }
        tenantContext.activate(principal);
        var access = chatAccess.requireActiveChat(principal.workspaceId(), chatId,
                principal.userId());
        // E2EE chats can never enable a MANAGED-only plugin; fail closed even if a future
        // caller forgets the plugin gate.
        if ("E2EE".equals(access.securityMode())) {
            throw DomainException.unprocessable(ErrorCode.PLUGIN_NOT_AVAILABLE,
                    "Plugin messages are not available in an E2EE chat",
                    Map.of("reason", "PLUGIN_NOT_AVAILABLE"));
        }

        String displayName = userProfile.displayName(principal.userId());
        long seq = seqAllocator.nextSeq(principal.workspaceId(), chatId);
        Instant now = clock.now();
        UUID messageId = UUID.randomUUID();
        Message message = type == Message.Type.POLL
                ? Message.createPoll(messageId, principal.workspaceId(), chatId, seq,
                        principal.userId(), principal.deviceId(), displayName, refId, now)
                : Message.createTask(messageId, principal.workspaceId(), chatId, seq,
                        principal.userId(), principal.deviceId(), displayName, refId, now);
        messageRepository.save(message);

        MessageView view = MessageView.from(message);
        if (type == Message.Type.POLL) {
            EmbeddedPollView poll = pluginContent.findPoll(principal.workspaceId(), chatId,
                    refId, principal.userId()).orElse(null);
            view = view.withPluginContent(poll, null);
        } else {
            EmbeddedTaskView task = pluginContent.findTask(principal.workspaceId(), chatId,
                    refId, principal.userId()).orElse(null);
            view = view.withPluginContent(null, task);
        }

        MessageCreatedEvent event = new MessageCreatedEvent(messageId, principal.workspaceId(),
                chatId, seq, principal.userId(), now, 0);
        outbox.append(new OutboxEvent(principal.workspaceId(), "message", messageId,
                "message.created", 1, chatId.toString(), MessageEventPayload.of(event, view),
                now));
        // AFTER_COMMIT listener; a rollback never fans out.
        events.publishEvent(new MessageCreatedNotification(principal.workspaceId(), view));
        return view;
    }
}
