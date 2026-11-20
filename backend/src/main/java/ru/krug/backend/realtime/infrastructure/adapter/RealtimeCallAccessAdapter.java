package ru.krug.backend.realtime.infrastructure.adapter;

import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.model.ChatAccess;
import ru.krug.backend.chat.application.port.ChatAccessPort;
import ru.krug.backend.chat.application.port.ChatPermissionPort;
import ru.krug.backend.chat.application.port.ChatWorkspacePort;
import ru.krug.backend.chat.domain.model.ChatPermission;
import ru.krug.backend.chat.domain.repository.ChatRepository;
import ru.krug.backend.realtime.application.model.CallKind;
import ru.krug.backend.realtime.application.model.RealtimeCallAccess;
import ru.krug.backend.realtime.application.port.RealtimeCallAccessPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;

/**
 * Call gate over the chat context: ACTIVE membership plus a live DIRECT/GROUP chat. Denials
 * are returned as values (never thrown) so the WS transport can answer without a
 * rollback-only read transaction and without revealing whether the chat exists or its type.
 *
 * <p>DIRECT keeps the original 1:1 semantics and yields exactly one peer. GROUP yields only
 * the validated requested recipients — never all active members — after checking every one
 * of them against the ACTIVE membership of the same chat.
 */
@Component
public class RealtimeCallAccessAdapter implements RealtimeCallAccessPort {

    private final ChatAccessPort chatAccess;
    private final ChatPermissionPort chatPermissions;
    private final ChatWorkspacePort chatWorkspace;
    private final ChatRepository chatRepository;
    private final TenantContext tenantContext;

    public RealtimeCallAccessAdapter(ChatAccessPort chatAccess,
                                     ChatPermissionPort chatPermissions,
                                     ChatWorkspacePort chatWorkspace,
                                     ChatRepository chatRepository,
                                     TenantContext tenantContext) {
        this.chatAccess = chatAccess;
        this.chatPermissions = chatPermissions;
        this.chatWorkspace = chatWorkspace;
        this.chatRepository = chatRepository;
        this.tenantContext = tenantContext;
    }

    @Override
    @Transactional(readOnly = true)
    public RealtimeCallAccess check(UUID workspaceId, UUID chatId, UUID userId, CallKind kind,
                                    boolean conference, Set<UUID> requestedRecipients,
                                    String requestId) {
        UUID resolvedWorkspace = workspaceId;
        if (resolvedWorkspace == null) {
            Optional<UUID> found = chatWorkspace.findWorkspaceForChat(chatId, userId);
            if (found.isEmpty()) {
                return RealtimeCallAccess.forbidden(null, null);
            }
            resolvedWorkspace = found.get();
        }
        final UUID workspace = resolvedWorkspace;
        tenantContext.activate(new Principal(userId, null, workspace,
                requestId == null ? "realtime-call" : requestId));

        Optional<ChatAccess> access = chatAccess.findActiveChat(workspace, chatId, userId);
        if (access.isEmpty()) {
            return RealtimeCallAccess.forbidden(workspace, null);
        }
        String chatType = access.get().chatType();
        // P0-2: the initial OFFER needs the configurable start_calls right. The check runs
        // here, inside the tenant-scoped read transaction, because the WS thread has no
        // request context. Answer/ICE/hangup of an authorized call are not re-gated.
        if (kind == CallKind.OFFER
                && !chatPermissions.isAllowed(workspace, chatId, userId,
                        ChatPermission.START_CALLS)) {
            return RealtimeCallAccess.forbidden(workspace, chatType);
        }
        List<UUID> activeMemberIds = chatRepository.findActiveMemberIds(workspace, chatId);

        if (RealtimeCallAccess.DIRECT.equals(chatType)) {
            if (conference || (requestedRecipients != null && !requestedRecipients.isEmpty())) {
                return RealtimeCallAccess.conferenceNotAllowed(workspace, chatType);
            }
            List<UUID> peers = activeMemberIds.stream()
                    .filter(memberId -> !memberId.equals(userId))
                    .toList();
            // A DIRECT chat has exactly one peer. More active members means a corrupted
            // chat: fail closed instead of broadcasting a 1:1 call to a group.
            if (peers.size() > 1) {
                return RealtimeCallAccess.notSupported(workspace, chatType);
            }
            return RealtimeCallAccess.accepted(workspace, chatType, Set.copyOf(peers));
        }

        if (RealtimeCallAccess.GROUP.equals(chatType)) {
            if (!conference || requestedRecipients == null || requestedRecipients.isEmpty()) {
                return RealtimeCallAccess.recipientsRequired(workspace, chatType);
            }
            Set<UUID> activeMembers = Set.copyOf(activeMemberIds);
            // One generic denial for "not a member", "caller in recipients" and "unknown
            // user id": the client must not be able to probe chat membership.
            if (requestedRecipients.contains(userId)
                    || !activeMembers.containsAll(requestedRecipients)) {
                return RealtimeCallAccess.forbidden(workspace, chatType);
            }
            return RealtimeCallAccess.accepted(workspace, chatType,
                    Set.copyOf(requestedRecipients));
        }

        return RealtimeCallAccess.notSupported(workspace, chatType);
    }
}
