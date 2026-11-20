package ru.krug.backend.plugin.application.usecase;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.chat.application.port.ChatPermissionPort;
import ru.krug.backend.chat.domain.model.ChatPermission;
import ru.krug.backend.plugin.application.model.PluginChatContext;
import ru.krug.backend.plugin.application.model.PollView;
import ru.krug.backend.plugin.domain.model.Poll;
import ru.krug.backend.plugin.domain.repository.PollRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Polls plugin actions ({@code #76}). All entry points first pass {@link PluginActionGate}:
 * ACTIVE chat membership and an enabled {@code polls} toggle are mandatory (E2EE fails
 * closed). Audit metadata contains ids only — never the question or option text.
 */
@Service
public class PollService {

    static final String PLUGIN_ID = "polls";
    static final String ACTION_CREATED = "chat.poll.created";
    static final String ACTION_CLOSED = "chat.poll.closed";
    static final String ACTION_VOTED = "chat.poll.voted";
    private static final int LIST_LIMIT = 100;

    private final PluginActionGate gate;
    private final ChatPermissionPort chatPermissions;
    private final PollRepository repository;
    private final AuditPort audit;
    private final ClockPort clock;

    public PollService(PluginActionGate gate, ChatPermissionPort chatPermissions,
                       PollRepository repository, AuditPort audit, ClockPort clock) {
        this.gate = gate;
        this.chatPermissions = chatPermissions;
        this.repository = repository;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public List<PollView> list(Principal principal, UUID chatId) {
        PluginChatContext context = gate.requireEnabled(principal, chatId, PLUGIN_ID);
        return repository.findByChat(context.workspaceId(), chatId, principal.userId(),
                        LIST_LIMIT).stream()
                .map(PollView::from)
                .toList();
    }

    @Transactional
    public PollView create(Principal principal, UUID chatId, String question,
                           List<String> options) {
        PluginChatContext context = gate.requireEnabled(principal, chatId, PLUGIN_ID);
        chatPermissions.requireAllowed(context.workspaceId(), chatId, principal.userId(),
                ChatPermission.CREATE_POLLS);
        Poll poll = Poll.create(context.workspaceId(), chatId, principal.userId(), question,
                options, clock.now(), UUID::randomUUID);
        repository.create(poll);
        audit.append(new AuditRecord(context.workspaceId(), principal.userId(),
                ACTION_CREATED, "poll", poll.id(), principal.requestId(), Map.of(),
                clock.now()));
        return PollView.from(poll);
    }

    @Transactional
    public PollView vote(Principal principal, UUID chatId, UUID pollId, UUID optionId) {
        PluginChatContext context = gate.requireEnabled(principal, chatId, PLUGIN_ID);
        Poll poll = requirePoll(context, chatId, pollId, principal.userId());
        if (poll.closed()) {
            throw DomainException.unprocessable(ErrorCode.POLL_CLOSED,
                    "Poll is closed", Map.of("poll_id", pollId));
        }
        if (!poll.hasOption(optionId)) {
            throw DomainException.unprocessable(ErrorCode.POLL_OPTION_INVALID,
                    "Option does not belong to this poll",
                    Map.of("poll_id", pollId, "option_id", optionId));
        }
        boolean changed = repository.vote(context.workspaceId(), chatId, pollId, optionId,
                principal.userId(), clock.now());
        if (changed) {
            audit.append(new AuditRecord(context.workspaceId(), principal.userId(),
                    ACTION_VOTED, "poll", pollId, principal.requestId(),
                    Map.of("option_id", optionId), clock.now()));
        }
        return PollView.from(requirePoll(context, chatId, pollId, principal.userId()));
    }

    @Transactional
    public PollView close(Principal principal, UUID chatId, UUID pollId, boolean closed) {
        PluginChatContext context = gate.requireEnabled(principal, chatId, PLUGIN_ID);
        Poll poll = requirePoll(context, chatId, pollId, principal.userId());
        if (!poll.isCreator(principal.userId())) {
            throw DomainException.forbidden("Only the poll creator can close it");
        }
        if (!closed) {
            throw DomainException.unprocessable(ErrorCode.POLL_STATE_INVALID,
                    "Only closing a poll is supported", Map.of("poll_id", pollId));
        }
        if (!poll.closed()) {
            boolean changed = repository.close(context.workspaceId(), chatId, pollId,
                    clock.now());
            if (changed) {
                audit.append(new AuditRecord(context.workspaceId(), principal.userId(),
                        ACTION_CLOSED, "poll", pollId, principal.requestId(), Map.of(),
                        clock.now()));
            }
        }
        return PollView.from(requirePoll(context, chatId, pollId, principal.userId()));
    }

    private Poll requirePoll(PluginChatContext context, UUID chatId, UUID pollId,
                             UUID viewerId) {
        return repository.findById(context.workspaceId(), chatId, pollId, viewerId)
                .orElseThrow(() -> DomainException.notFound("Poll not found"));
    }
}
