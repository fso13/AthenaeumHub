package ru.krug.backend.chat.application.usecase;

import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.chat.application.model.ChatAvatarView;
import ru.krug.backend.chat.application.model.ChatMembershipContext;
import ru.krug.backend.chat.application.model.ChatView;
import ru.krug.backend.chat.application.port.ChatAvatarPort;
import ru.krug.backend.chat.domain.model.ChannelSettings;
import ru.krug.backend.chat.domain.model.Chat;
import ru.krug.backend.chat.domain.repository.ChatRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * {@code POST/DELETE/GET /chats/{chatId}/avatar} — channel icon/avatar.
 *
 * <p>There is no new upload endpoint: the body references an existing managed attachment of
 * the same chat that must be a CLEAN/SKIPPED image, with exactly the cover rules
 * ({@link ChatAvatarPort}). Setting/clearing the avatar is part of the channel info, so an
 * ACTIVE chat OWNER/ADMIN is required and DIRECT/E2EE chats are rejected; the GET is readable
 * by any ACTIVE participant and answers {@code 302} to a short-lived presigned URL.</p>
 *
 * <p>The audit event carries no file id (metadata only). Repeating the same avatar is a no-op
 * without a second audit and DELETE is idempotent.</p>
 */
@Service
public class ChatAvatarService {

    static final String ACTION = "chat.avatar.updated";

    private final ChatMemberAccessService access;
    private final ChatRepository chatRepository;
    private final ChatAvatarPort avatarPort;
    private final ChatViewAssembler viewAssembler;
    private final AuditPort audit;
    private final ClockPort clock;

    public ChatAvatarService(ChatMemberAccessService access, ChatRepository chatRepository,
                             ChatAvatarPort avatarPort, ChatViewAssembler viewAssembler,
                             AuditPort audit, ClockPort clock) {
        this.access = access;
        this.chatRepository = chatRepository;
        this.avatarPort = avatarPort;
        this.viewAssembler = viewAssembler;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public ChatView setAvatar(Principal principal, UUID chatId, UUID fileId) {
        ChatMembershipContext context = access.resolve(principal, chatId);
        context.chat().requireChannelMembership();
        access.requireChannelManager(context);
        if (context.chat().securityMode() == Chat.SecurityMode.E2EE) {
            throw DomainException.unprocessable(ErrorCode.CHAT_SETTINGS_E2EE_UNSUPPORTED,
                    "An avatar is not supported for an E2EE chat",
                    Map.of("field", "avatar_file_id", "security_mode", "E2EE"));
        }
        UUID validated = avatarPort.requireAvatarAttachment(context.workspaceId(), chatId,
                fileId);
        ChannelSettings settings = chatRepository.findChannelSettings(context.workspaceId(),
                chatId).orElseGet(ChannelSettings::defaults);
        if (!chatRepository.updateAvatar(context.workspaceId(), chatId, validated)) {
            throw DomainException.notFound("Chat not found");
        }
        if (!validated.equals(settings.avatarFileId())) {
            audit.append(new AuditRecord(context.workspaceId(), principal.userId(), ACTION,
                    "chat", chatId, principal.requestId(), Map.of("changed", "avatar"),
                    clock.now()));
        }
        return viewAssembler.toView(context.chat(), principal.userId());
    }

    @Transactional
    public void removeAvatar(Principal principal, UUID chatId) {
        ChatMembershipContext context = access.resolve(principal, chatId);
        context.chat().requireChannelMembership();
        access.requireChannelManager(context);
        ChannelSettings settings = chatRepository.findChannelSettings(context.workspaceId(),
                chatId).orElseGet(ChannelSettings::defaults);
        if (!chatRepository.updateAvatar(context.workspaceId(), chatId, null)) {
            throw DomainException.notFound("Chat not found");
        }
        if (settings.avatarFileId() != null) {
            audit.append(new AuditRecord(context.workspaceId(), principal.userId(), ACTION,
                    "chat", chatId, principal.requestId(), Map.of("changed", "avatar"),
                    clock.now()));
        }
    }

    /**
     * Any ACTIVE participant; a non-participant is hidden as 404 (the avatar never discloses
     * a chat the caller cannot see). An unset avatar or a DIRECT chat is 404 as well.
     */
    @Transactional(readOnly = true)
    public ChatAvatarView download(Principal principal, UUID chatId) {
        ChatMembershipContext context = access.resolve(principal, chatId);
        access.requireParticipant(context);
        ChannelSettings settings = chatRepository.findChannelSettings(context.workspaceId(),
                chatId).orElseGet(ChannelSettings::defaults);
        if (settings.avatarFileId() == null) {
            throw DomainException.notFound("Avatar not found");
        }
        return avatarPort.download(context.workspaceId(), chatId, settings.avatarFileId())
                .map(value -> new ChatAvatarView(value.url(), value.expiresAt()))
                .orElseThrow(() -> DomainException.notFound("Avatar not found"));
    }
}
