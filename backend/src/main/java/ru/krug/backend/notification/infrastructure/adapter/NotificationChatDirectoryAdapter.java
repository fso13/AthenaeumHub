package ru.krug.backend.notification.infrastructure.adapter;

import java.util.Optional;
import java.util.UUID;

import org.springframework.stereotype.Component;

import ru.krug.backend.chat.application.model.ChatDirectorySnapshot;
import ru.krug.backend.chat.application.port.ChatMemberDirectoryPort;
import ru.krug.backend.chat.application.port.ChatWorkspacePort;
import ru.krug.backend.notification.application.port.ChatDirectoryPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;

/**
 * Bridges notification's read port to chat's published port. All chat SQL stays inside the
 * chat module; this adapter only activates the RLS workspace/user context around calls.
 */
@Component
public class NotificationChatDirectoryAdapter implements ChatDirectoryPort {

    private final TenantContext tenantContext;
    private final ChatWorkspacePort chatWorkspace;
    private final ChatMemberDirectoryPort chatDirectory;

    public NotificationChatDirectoryAdapter(TenantContext tenantContext,
                                             ChatWorkspacePort chatWorkspace,
                                             ChatMemberDirectoryPort chatDirectory) {
        this.tenantContext = tenantContext;
        this.chatWorkspace = chatWorkspace;
        this.chatDirectory = chatDirectory;
    }

    @Override
    public Optional<ChatDirectory> findChat(UUID workspaceId, UUID chatId) {
        if (workspaceId == null || chatId == null) {
            return Optional.empty();
        }
        tenantContext.activate(new Principal(null, null, workspaceId, "notification-fanout"));
        return chatDirectory.find(workspaceId, chatId).map(this::toView);
    }

    @Override
    public Optional<ChatDirectory> findForMember(UUID chatId, UUID userId) {
        if (chatId == null || userId == null) {
            return Optional.empty();
        }
        Optional<UUID> workspaceId = chatWorkspace.findWorkspaceForChat(chatId, userId);
        if (workspaceId.isEmpty()) {
            return Optional.empty();
        }
        return findChat(workspaceId.get(), chatId)
                .filter(chat -> chat.activeMemberIds().contains(userId));
    }

    private ChatDirectory toView(ChatDirectorySnapshot snapshot) {
        return new ChatDirectory(snapshot.chatId(), snapshot.workspaceId(), snapshot.name(),
                snapshot.e2ee(), snapshot.activeMemberIds());
    }
}
