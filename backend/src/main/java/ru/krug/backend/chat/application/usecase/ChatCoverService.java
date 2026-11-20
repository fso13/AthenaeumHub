package ru.krug.backend.chat.application.usecase;

import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.chat.application.model.ChatMembershipContext;
import ru.krug.backend.chat.application.model.ChatView;
import ru.krug.backend.chat.application.port.ChatCoverPort;
import ru.krug.backend.chat.domain.model.ChannelSettings;
import ru.krug.backend.chat.domain.model.Chat;
import ru.krug.backend.chat.domain.repository.ChatRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * {@code POST/DELETE /chats/{chatId}/cover} (P0-2 / #80).
 *
 * <p>There is no new upload endpoint: the body references an existing managed attachment that
 * must belong to this chat and be a CLEAN image ({@link ChatCoverPort}). The cover is part of
 * the channel info, so a chat OWNER/ADMIN is required; E2EE chats are managed-only and
 * reject a cover. DELETE is idempotent (204) and writes no audit when nothing changed.</p>
 */
@Service
public class ChatCoverService {

    static final String ACTION = "chat.cover.updated";

    private final ChatMemberAccessService access;
    private final ChatRepository chatRepository;
    private final ChatCoverPort coverPort;
    private final ChatViewAssembler viewAssembler;
    private final AuditPort audit;
    private final ClockPort clock;

    public ChatCoverService(ChatMemberAccessService access, ChatRepository chatRepository,
                            ChatCoverPort coverPort, ChatViewAssembler viewAssembler,
                            AuditPort audit, ClockPort clock) {
        this.access = access;
        this.chatRepository = chatRepository;
        this.coverPort = coverPort;
        this.viewAssembler = viewAssembler;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public ChatView setCover(Principal principal, UUID chatId, UUID fileId) {
        ChatMembershipContext context = access.resolve(principal, chatId);
        context.chat().requireChannelMembership();
        access.requireChannelManager(context);
        if (context.chat().securityMode() == Chat.SecurityMode.E2EE) {
            throw DomainException.unprocessable(ErrorCode.CHAT_SETTINGS_E2EE_UNSUPPORTED,
                    "A cover is not supported for an E2EE chat",
                    Map.of("field", "cover_file_id", "security_mode", "E2EE"));
        }
        UUID validated = coverPort.requireCoverAttachment(context.workspaceId(), chatId, fileId);
        ChannelSettings settings = chatRepository.findChannelSettings(context.workspaceId(),
                chatId).orElseGet(ChannelSettings::defaults);
        if (!chatRepository.updateCover(context.workspaceId(), chatId, validated)) {
            throw DomainException.notFound("Chat not found");
        }
        if (!validated.equals(settings.coverFileId())) {
            audit.append(new AuditRecord(context.workspaceId(), principal.userId(), ACTION,
                    "chat", chatId, principal.requestId(), Map.of(), clock.now()));
        }
        return viewAssembler.toView(context.chat(), principal.userId());
    }

    @Transactional
    public void removeCover(Principal principal, UUID chatId) {
        ChatMembershipContext context = access.resolve(principal, chatId);
        context.chat().requireChannelMembership();
        access.requireChannelManager(context);
        ChannelSettings settings = chatRepository.findChannelSettings(context.workspaceId(),
                chatId).orElseGet(ChannelSettings::defaults);
        if (!chatRepository.updateCover(context.workspaceId(), chatId, null)) {
            throw DomainException.notFound("Chat not found");
        }
        if (settings.coverFileId() != null) {
            audit.append(new AuditRecord(context.workspaceId(), principal.userId(), ACTION,
                    "chat", chatId, principal.requestId(), Map.of(), clock.now()));
        }
    }
}
