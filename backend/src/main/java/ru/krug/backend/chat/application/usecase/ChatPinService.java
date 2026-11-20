package ru.krug.backend.chat.application.usecase;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.chat.application.model.ChatMembershipContext;
import ru.krug.backend.chat.application.model.ChatPinResult;
import ru.krug.backend.chat.application.model.ChatPinView;
import ru.krug.backend.chat.application.port.ChatPinMessagePort;
import ru.krug.backend.chat.domain.model.Chat;
import ru.krug.backend.chat.domain.model.ChatMember;
import ru.krug.backend.chat.domain.model.ChatPermission;
import ru.krug.backend.chat.domain.model.ChatPin;
import ru.krug.backend.chat.domain.repository.ChatRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * {@code GET/POST /chats/{chatId}/pins} and {@code DELETE /pins/{messageId}} (P0-2 / #80).
 *
 * <ul>
 *   <li>GROUP only; any ACTIVE participant may list, pin/unpin requires
 *       {@code pin_messages} (OWNER/ADMIN/MODERATOR by default);</li>
 *   <li>the message must exist in the same chat and must not be deleted for all; the check
 *       runs in the message context through {@link ChatPinMessagePort}, so the chat module
 *       never reads message content or ciphertext;</li>
 *   <li>E2EE pins are rejected ({@code 422 E2EE_METADATA_FORBIDDEN}) because pin metadata
 *       would leak server-visible relationships of an E2EE timeline;</li>
 *   <li>(chat_id, message_id) is unique: a repeated pin is an idempotent no-op (no extra
 *       audit), at most {@value #MAX_PINS} pins per channel ({@code 409 CHAT_PIN_LIMIT}),
 *       and unpin of an absent pin is an idempotent 204;</li>
 *   <li>audit metadata is the message id only.</li>
 * </ul>
 */
@Service
public class ChatPinService {

    static final String ACTION_PINNED = "chat.pin.added";
    static final String ACTION_UNPINNED = "chat.pin.removed";
    static final int MAX_PINS = 50;

    private final ChatMemberAccessService access;
    private final ChatRepository chatRepository;
    private final ChatPermissionService permissions;
    private final ChatPinMessagePort messagePort;
    private final AuditPort audit;
    private final ClockPort clock;

    public ChatPinService(ChatMemberAccessService access, ChatRepository chatRepository,
                          ChatPermissionService permissions, ChatPinMessagePort messagePort,
                          AuditPort audit, ClockPort clock) {
        this.access = access;
        this.chatRepository = chatRepository;
        this.permissions = permissions;
        this.messagePort = messagePort;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public List<ChatPinView> list(Principal principal, UUID chatId) {
        ChatMembershipContext context = readContext(principal, chatId);
        List<ChatPin> pins = chatRepository.findPins(context.workspaceId(), chatId);
        Set<UUID> accessible = messagePort.filterAccessible(context.workspaceId(), chatId,
                pins.stream().map(ChatPin::messageId).toList());
        return pins.stream()
                .filter(pin -> accessible.contains(pin.messageId()))
                .map(ChatPinService::toView)
                .toList();
    }

    /** @return the stored pin plus whether this call created it (idempotent repeat = false) */
    @Transactional
    public ChatPinResult pin(Principal principal, UUID chatId, UUID messageId) {
        ChatMembershipContext context = access.resolve(principal, chatId);
        context.chat().requireChannelMembership();
        ChatMember actor = access.requireParticipant(context);
        requireMetadataAllowed(context.chat());
        permissions.requireAllowed(context.chat(), context.workspaceId(), chatId,
                actor.role(), ChatPermission.PIN_MESSAGES);

        if (!messagePort.isAccessibleMessage(context.workspaceId(), chatId, messageId)) {
            throw DomainException.notFound("Message not found");
        }
        ChatPin existing = chatRepository.findPin(context.workspaceId(), chatId, messageId)
                .orElse(null);
        if (existing != null) {
            return new ChatPinResult(false, toView(existing));
        }
        if (chatRepository.countPins(context.workspaceId(), chatId) >= MAX_PINS) {
            throw DomainException.conflict(ErrorCode.CHAT_PIN_LIMIT,
                    "The channel has reached the pin limit",
                    Map.of("limit", MAX_PINS));
        }
        chatRepository.pinMessage(context.workspaceId(), chatId, messageId,
                principal.userId(), clock.now());
        audit.append(new AuditRecord(context.workspaceId(), principal.userId(), ACTION_PINNED,
                "chat", chatId, principal.requestId(),
                Map.of("message_id", messageId.toString()), clock.now()));
        return new ChatPinResult(true,
                toView(chatRepository.findPin(context.workspaceId(), chatId, messageId)
                        .orElseThrow(() -> DomainException.notFound("Message not found"))));
    }

    @Transactional
    public void unpin(Principal principal, UUID chatId, UUID messageId) {
        ChatMembershipContext context = access.resolve(principal, chatId);
        context.chat().requireChannelMembership();
        ChatMember actor = access.requireParticipant(context);
        requireMetadataAllowed(context.chat());
        permissions.requireAllowed(context.chat(), context.workspaceId(), chatId,
                actor.role(), ChatPermission.PIN_MESSAGES);

        if (chatRepository.unpinMessage(context.workspaceId(), chatId, messageId)) {
            audit.append(new AuditRecord(context.workspaceId(), principal.userId(),
                    ACTION_UNPINNED, "chat", chatId, principal.requestId(),
                    Map.of("message_id", messageId.toString()), clock.now()));
        }
    }

    private ChatMembershipContext readContext(Principal principal, UUID chatId) {
        ChatMembershipContext context = access.resolve(principal, chatId);
        context.chat().requireChannelMembership();
        access.requireParticipant(context);
        return context;
    }

    private static ChatPinView toView(ChatPin pin) {
        return new ChatPinView(pin.chatId(), pin.messageId(), pin.pinnedBy(), pin.pinnedAt());
    }

    private static void requireMetadataAllowed(Chat chat) {
        if (chat.securityMode() == Chat.SecurityMode.E2EE) {
            throw DomainException.unprocessable(ErrorCode.E2EE_METADATA_FORBIDDEN,
                    "Pins are not supported for an E2EE chat",
                    Map.of("field", "pins", "security_mode", "E2EE"));
        }
    }
}
