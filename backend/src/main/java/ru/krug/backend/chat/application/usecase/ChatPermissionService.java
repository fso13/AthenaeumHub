package ru.krug.backend.chat.application.usecase;

import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.port.ChatPermissionPort;
import ru.krug.backend.chat.domain.model.ChannelSettings;
import ru.krug.backend.chat.domain.model.Chat;
import ru.krug.backend.chat.domain.model.ChatMember;
import ru.krug.backend.chat.domain.model.ChatPermission;
import ru.krug.backend.chat.domain.repository.ChatRepository;
import ru.krug.backend.chat.domain.service.ChatPermissionPolicy;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Enforces the configurable P0-2 rights matrix and the read-only flag. This is the single
 * implementation behind {@link ChatPermissionPort} (message send, poll creation, call offer)
 * and the in-context services (invites, pins, settings).
 *
 * <p>Rules:</p>
 * <ul>
 *   <li>an ACTIVE participant row is required; a missing/removed member is a hidden 404;</li>
 *   <li>DIRECT chats have no matrix and no read-only flag — both participants may write;</li>
 *   <li>read-only channels deny {@code post_messages}/{@code create_polls} to every role
 *       except chat OWNER/ADMIN ({@code 403 CHAT_READ_ONLY}); the per-role row is still
 *       checked afterwards;</li>
 *   <li>a missing permission row falls back to the built-in default (defensive only: rows
 *       are seeded on channel creation and backfilled by V41);</li>
 *   <li>a denied right is {@code 403 CHAT_PERMISSION_DENIED} with the permission name.</li>
 * </ul>
 */
@Service
public class ChatPermissionService implements ChatPermissionPort {

    private final ChatRepository chatRepository;

    public ChatPermissionService(ChatRepository chatRepository) {
        this.chatRepository = chatRepository;
    }

    @Override
    @Transactional(readOnly = true)
    public void requireAllowed(UUID workspaceId, UUID chatId, UUID userId,
                               ChatPermission permission) {
        Chat chat = chatRepository.findById(workspaceId, chatId)
                .orElseThrow(() -> DomainException.notFound("Chat not found"));
        ChatMember member = chatRepository.findMember(chatId, userId)
                .filter(ChatMember::isActive)
                .orElseThrow(() -> DomainException.notFound("Chat not found"));
        requireAllowed(chat, workspaceId, chatId, member.role(), permission);
    }

    @Override
    @Transactional(readOnly = true)
    public boolean isAllowed(UUID workspaceId, UUID chatId, UUID userId,
                             ChatPermission permission) {
        Chat chat = chatRepository.findById(workspaceId, chatId).orElse(null);
        if (chat == null) {
            return false;
        }
        ChatMember member = chatRepository.findMember(chatId, userId)
                .filter(ChatMember::isActive).orElse(null);
        if (member == null) {
            return false;
        }
        if (chat.type() != Chat.Type.GROUP) {
            return true;
        }
        ChannelSettings settings = chatRepository.findChannelSettings(workspaceId, chatId)
                .orElseGet(ChannelSettings::defaults);
        boolean write = permission == ChatPermission.POST_MESSAGES
                || permission == ChatPermission.CREATE_POLLS;
        if (settings.readOnly() && write
                && !ChatPermissionPolicy.readOnlyManager(member.role().name())) {
            return false;
        }
        return allows(workspaceId, chatId, member.role(), permission);
    }

    @Transactional(readOnly = true)
    public void requireAllowed(Chat chat, UUID workspaceId, UUID chatId,
                               ChatMember.Role role, ChatPermission permission) {
        if (chat.type() != Chat.Type.GROUP) {
            return;
        }
        ChannelSettings settings = chatRepository.findChannelSettings(workspaceId, chatId)
                .orElseGet(ChannelSettings::defaults);
        boolean write = permission == ChatPermission.POST_MESSAGES
                || permission == ChatPermission.CREATE_POLLS;
        if (settings.readOnly() && write
                && !ChatPermissionPolicy.readOnlyManager(role.name())) {
            throw DomainException.forbidden(ErrorCode.CHAT_READ_ONLY,
                    "The channel is read-only", Map.of("chat_id", chatId.toString()));
        }
        if (!allows(workspaceId, chatId, role, permission)) {
            throw DomainException.forbidden(ErrorCode.CHAT_PERMISSION_DENIED,
                    "The channel role lacks this permission",
                    Map.of("permission", permission.wire(), "role", role.name()));
        }
    }

    /** Effective value: persisted row when present, built-in default otherwise. */
    @Transactional(readOnly = true)
    public boolean allows(UUID workspaceId, UUID chatId, ChatMember.Role role,
                          ChatPermission permission) {
        Map<ChatPermission, Boolean> stored = chatRepository.findPermissions(workspaceId,
                chatId, role.name());
        return stored.getOrDefault(permission,
                ChatPermissionPolicy.defaultAllowed(role, permission));
    }
}
