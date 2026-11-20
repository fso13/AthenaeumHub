package ru.krug.backend.chat.application.usecase;

import java.util.List;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.model.ChatListView;
import ru.krug.backend.chat.application.model.ChatSummaryView;
import ru.krug.backend.chat.application.model.SyncChatView;
import ru.krug.backend.chat.application.model.SyncView;
import ru.krug.backend.chat.domain.model.ChatSummary;
import ru.krug.backend.chat.domain.repository.ChatRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.workspace.application.port.WorkspaceAccessPort;

@Service
public class ChatQueryService {

    private final TenantContext tenantContext;
    private final WorkspaceAccessPort workspaceAccess;
    private final ChatRepository chatRepository;
    private final ClockPort clock;

    public ChatQueryService(TenantContext tenantContext, WorkspaceAccessPort workspaceAccess,
                            ChatRepository chatRepository, ClockPort clock) {
        this.tenantContext = tenantContext;
        this.workspaceAccess = workspaceAccess;
        this.chatRepository = chatRepository;
        this.clock = clock;
    }

    /**
     * @param archived {@code true} returns only the caller's archived channels, {@code null}
     *                 or {@code false} the main (not archived) list. The archive is
     *                 user-local; another participant's view is never affected.
     */
    @Transactional(readOnly = true)
    public ChatListView listChats(Principal principal, UUID workspaceId, Boolean archived) {
        tenantContext.activate(principal.withWorkspace(workspaceId));
        workspaceAccess.requireActiveMember(workspaceId, principal.userId());
        List<ChatSummaryView> items = chatRepository
                .listActiveSummaries(workspaceId, principal.userId(), Boolean.TRUE.equals(archived))
                .stream()
                .map(ChatQueryService::toView)
                .toList();
        return new ChatListView(items);
    }

    @Transactional(readOnly = true)
    public SyncView sync(Principal principal, UUID workspaceId) {
        tenantContext.activate(principal.withWorkspace(workspaceId));
        workspaceAccess.requireActiveMember(workspaceId, principal.userId());
        List<SyncChatView> chats = chatRepository
                .listActiveSummaries(workspaceId, principal.userId())
                .stream()
                .map(chat -> new SyncChatView(chat.id(), chat.lastSeq(), chat.unreadCount()))
                .toList();
        return new SyncView(clock.now(), chats);
    }

    private static ChatSummaryView toView(ChatSummary summary) {
        return new ChatSummaryView(summary.id(), summary.name(), summary.description(),
                summary.type().name(), summary.securityMode().name(),
                summary.visibility() == null ? null : summary.visibility().name(),
                summary.lastMessageAt(), summary.unreadCount(), summary.lastSeq(),
                summary.peerId(), summary.peerHasE2eeCapableDevices(), summary.createdAt(),
                summary.coverFileId(), summary.readOnly(),
                summary.joinPolicy() == null ? null : summary.joinPolicy().name(),
                summary.archived());
    }
}
