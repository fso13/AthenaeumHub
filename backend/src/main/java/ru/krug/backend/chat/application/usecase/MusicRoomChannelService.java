package ru.krug.backend.chat.application.usecase;

import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.chat.application.model.ChatUsageView;
import ru.krug.backend.chat.application.model.ChatView;
import ru.krug.backend.chat.application.port.ChatUsagePort;
import ru.krug.backend.chat.application.port.MusicRoomChannelPort;
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
import ru.krug.backend.workspace.application.port.WorkspaceAccessPort;

/**
 * Chat-side half of the #94 music room.
 *
 * <p>{@link #createPublicChannel} reuses the channel creation invariants: the workspace
 * creation lock and installation counters are read in the same transaction as the insert,
 * the creator is OWNER, every ACTIVE workspace member joins, visibility is PUBLIC (join
 * policy OPEN) and the audit metadata stays limited to {@code visibility}/{@code
 * member_count}. No audio, playback state or SFU session is created here.</p>
 */
@Service
public class MusicRoomChannelService implements MusicRoomChannelPort {

    static final String AUDIT_ACTION = "chat.created";

    private final TenantContext tenantContext;
    private final WorkspaceAccessPort workspaceAccess;
    private final ChatRepository chatRepository;
    private final ChatUsagePort chatUsage;
    private final ChatViewAssembler viewAssembler;
    private final AuditPort audit;
    private final ClockPort clock;

    public MusicRoomChannelService(TenantContext tenantContext,
                                   WorkspaceAccessPort workspaceAccess,
                                   ChatRepository chatRepository,
                                   ChatUsagePort chatUsage,
                                   ChatViewAssembler viewAssembler,
                                   AuditPort audit,
                                   ClockPort clock) {
        this.tenantContext = tenantContext;
        this.workspaceAccess = workspaceAccess;
        this.chatRepository = chatRepository;
        this.chatUsage = chatUsage;
        this.viewAssembler = viewAssembler;
        this.audit = audit;
        this.clock = clock;
    }

    @Override
    @Transactional
    public ChatView createPublicChannel(Principal principal, UUID workspaceId, String name) {
        tenantContext.activate(principal.withWorkspace(workspaceId));
        workspaceAccess.requireActiveMember(workspaceId, principal.userId());

        String mode = chatRepository.findWorkspaceSecurityMode(workspaceId);
        if (mode == null) {
            throw DomainException.notFound("Workspace not found");
        }
        Chat.requireSupportedType(Chat.SecurityMode.valueOf(mode), Chat.Type.GROUP);

        chatRepository.lockChatCreation(workspaceId);
        enforceChatLimits(workspaceId, principal.userId());

        Chat chat = Chat.createGroup(UUID.randomUUID(), workspaceId, principal.userId(),
                name, Chat.SecurityMode.valueOf(mode));
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
        return viewAssembler.toView(chat, principal.userId());
    }

    @Override
    @Transactional(readOnly = true)
    public String workspaceSecurityMode(UUID workspaceId) {
        return chatRepository.findWorkspaceSecurityMode(workspaceId);
    }

    @Override
    @Transactional(readOnly = true)
    public boolean isLiveGroupChannel(UUID workspaceId, UUID chatId) {
        return chatRepository.findById(workspaceId, chatId)
                .filter(chat -> chat.type() == Chat.Type.GROUP)
                .isPresent();
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<ChatView> findVisibleChannel(UUID workspaceId, UUID chatId, UUID userId) {
        Optional<Chat> chat = chatRepository.findById(workspaceId, chatId)
                .filter(item -> item.type() == Chat.Type.GROUP);
        if (chat.isEmpty()) {
            return Optional.empty();
        }
        boolean activeMember = chatRepository.findMember(chatId, userId)
                .filter(ChatMember::isActive)
                .isPresent();
        if (!activeMember) {
            return Optional.empty();
        }
        return Optional.of(viewAssembler.toView(chat.get(), userId));
    }

    private void enforceChatLimits(UUID workspaceId, UUID userId) {
        ChatUsageView usage = chatUsage.usage(workspaceId, userId);
        ChatLimitPolicy.requireUserCapacity(usage.chatsUsedByUser(), usage.maxChatsPerUser());
        ChatLimitPolicy.requireWorkspaceCapacity(usage.chatsUsedInWorkspace(),
                usage.maxChatsPerWorkspace());
    }
}
