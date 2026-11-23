package ru.krug.backend.chat.application.usecase;

import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.chat.application.model.ChatUsageView;
import ru.krug.backend.chat.application.port.ChatUsagePort;
import ru.krug.backend.chat.application.port.RoomChannelPort;
import ru.krug.backend.chat.domain.model.ChannelVisibility;
import ru.krug.backend.chat.domain.model.Chat;
import ru.krug.backend.chat.domain.model.ChatCounter;
import ru.krug.backend.chat.domain.model.ChatMember;
import ru.krug.backend.chat.domain.repository.ChatRepository;
import ru.krug.backend.chat.domain.service.ChatLimitPolicy;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.workspace.application.port.WorkspaceAccessPort;

/**
 * Chat-side implementation of {@link RoomChannelPort} (#105).
 *
 * <p>A room backing channel is a MANAGED PUBLIC GROUP channel: the creator is OWNER, every
 * ACTIVE workspace member joins immediately, the join policy is OPEN and the default role
 * permission matrix is seeded. Rooms are deliberately MANAGED-only, so an E2EE workspace is
 * rejected rather than silently creating a plaintext channel there. The existing call
 * signalling then works on the returned {@code chat_id} without any new WS frame.</p>
 */
@Service
public class RoomChannelService implements RoomChannelPort {

    static final String AUDIT_ACTION = "chat.created";

    private final TenantContext tenantContext;
    private final WorkspaceAccessPort workspaceAccess;
    private final ChatRepository chatRepository;
    private final ChatUsagePort chatUsage;
    private final AuditPort audit;
    private final ClockPort clock;

    public RoomChannelService(TenantContext tenantContext,
                              WorkspaceAccessPort workspaceAccess,
                              ChatRepository chatRepository,
                              ChatUsagePort chatUsage,
                              AuditPort audit,
                              ClockPort clock) {
        this.tenantContext = tenantContext;
        this.workspaceAccess = workspaceAccess;
        this.chatRepository = chatRepository;
        this.chatUsage = chatUsage;
        this.audit = audit;
        this.clock = clock;
    }

    @Override
    @Transactional
    public UUID createBackingChannel(Principal principal, UUID workspaceId, String name) {
        tenantContext.activate(principal.withWorkspace(workspaceId));
        workspaceAccess.requireActiveMember(workspaceId, principal.userId());

        String mode = chatRepository.findWorkspaceSecurityMode(workspaceId);
        if (mode == null) {
            throw DomainException.notFound("Workspace not found");
        }
        if (!Chat.SecurityMode.MANAGED.name().equals(mode)) {
            // Rooms are MANAGED only (#105): no server-side E2EE room in this slice.
            throw DomainException.conflict(ErrorCode.E2EE_GROUP_NOT_SUPPORTED,
                    "Rooms are MANAGED-only and are not available in an E2EE workspace",
                    Map.of("security_mode", mode));
        }

        chatRepository.lockChatCreation(workspaceId);
        enforceChatLimits(workspaceId, principal.userId());

        Chat chat = Chat.createGroup(UUID.randomUUID(), workspaceId, principal.userId(), name,
                Chat.SecurityMode.MANAGED);
        chatRepository.saveChat(chat, ChatMember.owner(chat.id(), principal.userId()),
                ChatCounter.newCounter(chat.id()));
        chatRepository.saveChannelSettings(workspaceId, chat.id(), ChannelVisibility.PUBLIC);
        // The owner row already exists, so the returned insert count excludes the creator.
        int memberCount = chatRepository.addActiveWorkspaceMembers(workspaceId, chat.id()) + 1;

        audit.append(new AuditRecord(workspaceId, principal.userId(), AUDIT_ACTION, "chat",
                chat.id(), principal.requestId(),
                Map.of("visibility", ChannelVisibility.PUBLIC.name(),
                        "member_count", memberCount),
                clock.now()));
        return chat.id();
    }

    @Override
    @Transactional
    public void renameBackingChannel(Principal principal, UUID workspaceId, UUID chatId,
                                     String name) {
        tenantContext.activate(principal.withWorkspace(workspaceId));
        workspaceAccess.requireActiveMember(workspaceId, principal.userId());
        Chat chat = chatRepository.findById(workspaceId, chatId)
                .filter(item -> item.type() == Chat.Type.GROUP)
                .orElseThrow(() -> DomainException.notFound("Room channel not found"));
        Chat renamed = chat.withSettings(name, chat.description());
        if (!chatRepository.updateDetails(renamed)) {
            throw DomainException.notFound("Room channel not found");
        }
    }

    @Override
    @Transactional
    public void closeBackingChannel(Principal principal, UUID workspaceId, UUID chatId) {
        tenantContext.activate(principal.withWorkspace(workspaceId));
        workspaceAccess.requireActiveMember(workspaceId, principal.userId());
        // Idempotent: an already soft-deleted channel needs no second write.
        chatRepository.softDeleteChat(workspaceId, chatId);
    }

    private void enforceChatLimits(UUID workspaceId, UUID userId) {
        ChatUsageView usage = chatUsage.usage(workspaceId, userId);
        ChatLimitPolicy.requireUserCapacity(usage.chatsUsedByUser(), usage.maxChatsPerUser());
        ChatLimitPolicy.requireWorkspaceCapacity(usage.chatsUsedInWorkspace(),
                usage.maxChatsPerWorkspace());
    }
}
