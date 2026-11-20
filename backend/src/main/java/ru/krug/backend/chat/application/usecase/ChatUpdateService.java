package ru.krug.backend.chat.application.usecase;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.chat.application.command.ChatUpdateCommand;
import ru.krug.backend.chat.application.model.ChatView;
import ru.krug.backend.chat.domain.model.ChannelVisibility;
import ru.krug.backend.chat.domain.model.Chat;
import ru.krug.backend.chat.domain.model.ChatSettingsScope;
import ru.krug.backend.chat.domain.model.ChatSummary;
import ru.krug.backend.chat.domain.repository.ChatRepository;
import ru.krug.backend.chat.domain.service.ChatSettingsPolicy;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * {@code PATCH /chats/{chatId}} (D1-BE3, docs/TASKS-DASHBOARD-V1.md §3.4): edit a chat's
 * name and/or description.
 *
 * <p>Authorization is workspace-level: the caller must be an ACTIVE workspace
 * {@code OWNER}/{@code ADMIN}. Chat membership is deliberately not required, so an admin
 * added after the chat exists can still manage it. The workspace is resolved from the
 * chat by the V30 {@code chat.settings_scope} function because the URL has no workspace
 * segment; that function also hides unknown/deleted/foreign chats as {@code 404}.</p>
 *
 * <p>The audit event carries only the changed field <em>names</em> — never the name or
 * description values, and never message content. E2EE chats accept a name label only;
 * a description is rejected before any write.</p>
 */
@Service
public class ChatUpdateService {

    static final String ACTION = "chat.updated";

    private final TenantContext tenantContext;
    private final ChatRepository chatRepository;
    private final AuditPort audit;
    private final ClockPort clock;

    public ChatUpdateService(TenantContext tenantContext, ChatRepository chatRepository,
                             AuditPort audit, ClockPort clock) {
        this.tenantContext = tenantContext;
        this.chatRepository = chatRepository;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public ChatView update(Principal principal, UUID chatId, ChatUpdateCommand command) {
        if (command.isEmpty()) {
            throw DomainException.unprocessable(ErrorCode.VALIDATION_FAILED,
                    "At least one of name or description is required",
                    Map.of("reason", "empty_patch"));
        }
        // Resolve the workspace from the chat with only the user GUC active. The narrow
        // SECURITY DEFINER lookup verifies ACTIVE workspace membership itself.
        tenantContext.activate(principal.withWorkspace(null));
        ChatSettingsScope scope = chatRepository.findSettingsScope(chatId, principal.userId())
                .orElseThrow(() -> DomainException.notFound("Chat not found"));
        if (!scope.canManage()) {
            throw DomainException.forbidden(
                    "Only an active workspace OWNER or ADMIN can update chat settings");
        }
        tenantContext.activate(principal.withWorkspace(scope.workspaceId()));

        Chat chat = chatRepository.findById(scope.workspaceId(), chatId)
                .orElseThrow(() -> DomainException.notFound("Chat not found"));

        if (command.description() != null) {
            ChatSettingsPolicy.requireDescriptionAllowed(
                    chat.securityMode() == Chat.SecurityMode.E2EE);
        }

        String name = command.name() == null
                ? chat.name()
                : ChatSettingsPolicy.name(command.name());
        String description = command.description() == null
                ? chat.description()
                : ChatSettingsPolicy.description(command.description());

        List<String> changedFields = new ArrayList<>(2);
        if (command.name() != null) {
            changedFields.add("name");
        }
        if (command.description() != null) {
            changedFields.add("description");
        }

        Chat updated = chat.withSettings(name, description);
        if (!chatRepository.updateDetails(updated)) {
            // The chat was soft-deleted concurrently; do not claim a successful update.
            throw DomainException.notFound("Chat not found");
        }

        audit.append(new AuditRecord(scope.workspaceId(), principal.userId(), ACTION, "chat",
                chatId, principal.requestId(), Map.of("fields", List.copyOf(changedFields)),
                clock.now()));

        return toView(updated, principal.userId());
    }

    private ChatView toView(Chat chat, UUID viewerId) {
        ChatSummary summary = chatRepository
                .listActiveSummaries(chat.workspaceId(), viewerId).stream()
                .filter(item -> item.id().equals(chat.id()))
                .findFirst()
                .orElse(null);
        if (summary != null) {
            return new ChatView(summary.id(), summary.type().name(),
                    summary.securityMode().name(),
                    summary.visibility() == null ? null : summary.visibility().name(),
                    summary.peerId(), summary.peerHasE2eeCapableDevices(), summary.name(),
                    summary.description(), null, summary.lastSeq(), summary.unreadCount(),
                    summary.createdAt());
        }
        // A workspace OWNER/ADMIN who is not a chat member can still manage settings; the
        // response then has no personal unread counter, but remains a valid full Chat.
        ChannelVisibility visibility = chat.type() == Chat.Type.GROUP
                ? chatRepository.findChannelVisibility(chat.workspaceId(), chat.id())
                        .orElse(null)
                : null;
        return new ChatView(chat.id(), chat.type().name(), chat.securityMode().name(),
                visibility == null ? null : visibility.name(), null, false, chat.name(),
                chat.description(), null, chatRepository.lastSeq(chat.id()), 0,
                chat.createdAt());
    }
}
