package ru.krug.backend.chat.api.mapper;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import ru.krug.backend.chat.api.dto.ChatInviteCreatedResponse;
import ru.krug.backend.chat.api.dto.ChatInviteListResponse;
import ru.krug.backend.chat.api.dto.ChatInviteResponse;
import ru.krug.backend.chat.api.dto.ChatListResponse;
import ru.krug.backend.chat.api.dto.ChatMemberIdsResponse;
import ru.krug.backend.chat.api.dto.ChatMemberResponse;
import ru.krug.backend.chat.api.dto.ChatPermissionsResponse;
import ru.krug.backend.chat.api.dto.ChatPermissionsUpdateRequest;
import ru.krug.backend.chat.api.dto.ChatPinListResponse;
import ru.krug.backend.chat.api.dto.ChatPinResponse;
import ru.krug.backend.chat.api.dto.ChatResponse;
import ru.krug.backend.chat.api.dto.ChatRolePermissionsRequest;
import ru.krug.backend.chat.api.dto.ChatRolePermissionsResponse;
import ru.krug.backend.chat.api.dto.ChatSummaryResponse;
import ru.krug.backend.chat.api.dto.ChatUpdateRequest;
import ru.krug.backend.chat.api.dto.InviteAcceptResponse;
import ru.krug.backend.chat.api.dto.SyncChatState;
import ru.krug.backend.chat.api.dto.SyncResponse;
import ru.krug.backend.chat.application.command.ChatUpdateCommand;
import ru.krug.backend.chat.application.model.ChatInviteCreatedView;
import ru.krug.backend.chat.application.model.ChatInviteView;
import ru.krug.backend.chat.application.model.ChatListView;
import ru.krug.backend.chat.application.model.ChatMemberListView;
import ru.krug.backend.chat.application.model.ChatMemberView;
import ru.krug.backend.chat.application.model.ChatPermissionsView;
import ru.krug.backend.chat.application.model.ChatPinView;
import ru.krug.backend.chat.application.model.ChatSummaryView;
import ru.krug.backend.chat.application.model.ChatView;
import ru.krug.backend.chat.application.model.InviteAcceptanceView;
import ru.krug.backend.chat.application.model.SyncView;

/**
 * Application result -> API DTO. The API layer never sees domain classes.
 */
public final class ChatApiMapper {

    private ChatApiMapper() {
    }

    public static ChatMemberIdsResponse toResponse(ChatMemberListView view) {
        return new ChatMemberIdsResponse(view.userIds(), view.members().stream()
                .map(ChatApiMapper::toResponse)
                .toList());
    }

    public static ChatMemberResponse toResponse(ChatMemberView view) {
        return new ChatMemberResponse(view.userId(), view.displayName(), view.role(),
                view.status(), view.joinedAt());
    }

    public static ChatInviteResponse toResponse(ChatInviteView view) {
        return new ChatInviteResponse(view.id(), view.role(), view.status(), view.usedCount(),
                view.maxUses(), view.expiresAt(), view.createdAt(), view.createdBy());
    }

    public static ChatInviteCreatedResponse toResponse(ChatInviteCreatedView view) {
        ChatInviteView invite = view.invite();
        return new ChatInviteCreatedResponse(invite.id(), invite.role(), invite.status(),
                invite.usedCount(), invite.maxUses(), invite.expiresAt(), invite.createdAt(),
                invite.createdBy(), view.token());
    }

    public static ChatInviteListResponse toInviteListResponse(List<ChatInviteView> views) {
        return new ChatInviteListResponse(views.stream().map(ChatApiMapper::toResponse).toList());
    }

    public static InviteAcceptResponse toResponse(InviteAcceptanceView view) {
        return new InviteAcceptResponse(view.inviteId(), view.workspaceId(), view.chatId(),
                view.role(), view.alreadyMember());
    }

    public static ChatListResponse toResponse(ChatListView view) {
        return new ChatListResponse(view.items().stream()
                .map(ChatApiMapper::toResponse)
                .toList());
    }

    public static ChatSummaryResponse toResponse(ChatSummaryView view) {
        return new ChatSummaryResponse(view.id(), view.name(), view.description(), view.type(),
                view.securityMode(), view.visibility(), view.peerId(),
                view.peerHasE2eeCapableDevices(), view.lastMessageAt(), view.unreadCount(),
                view.lastSeq(), view.coverFileId(), view.avatarFileId(), view.readOnly(),
                view.joinPolicy(), view.archived());
    }

    public static ChatResponse toResponse(ChatView view) {
        return new ChatResponse(view.id(), view.type(), view.securityMode(), view.visibility(),
                view.peerId(), view.peerHasE2eeCapableDevices(), view.name(),
                view.description(), view.keyEpoch(), view.lastSeq(), view.unreadCount(),
                view.createdAt(), view.coverFileId(), view.avatarFileId(), view.readOnly(),
                view.joinPolicy(), view.archived());
    }

    public static ChatPermissionsResponse toResponse(ChatPermissionsView view) {
        return new ChatPermissionsResponse(
                toRolePermissions(view.of("OWNER")),
                toRolePermissions(view.of("ADMIN")),
                toRolePermissions(view.of("MODERATOR")),
                toRolePermissions(view.of("MEMBER")),
                toRolePermissions(view.of("GUEST")));
    }

    public static ChatPinResponse toResponse(ChatPinView view) {
        return new ChatPinResponse(view.chatId(), view.messageId(), view.pinnedBy(),
                view.pinnedAt());
    }

    public static ChatPinListResponse toPinListResponse(List<ChatPinView> views) {
        return new ChatPinListResponse(views.stream().map(ChatApiMapper::toResponse).toList());
    }

    /** API request -> application command; the raw rights map keeps the API domain-free. */
    public static ChatUpdateCommand toCommand(ChatUpdateRequest request) {
        return new ChatUpdateCommand(request.name(), request.description(),
                request.coverFileId(), request.readOnly(), request.visibility(),
                request.joinPolicy(), toRightsMap(request.rights()));
    }

    /** API rights patch -> wire-shaped map consumed by the application/domain policy. */
    public static Map<String, Map<String, Boolean>> toRightsMap(
            ChatPermissionsUpdateRequest request) {
        if (request == null) {
            return null;
        }
        Map<String, Map<String, Boolean>> rights = new LinkedHashMap<>();
        putRole(rights, "OWNER", request.owner());
        putRole(rights, "ADMIN", request.admin());
        putRole(rights, "MODERATOR", request.moderator());
        putRole(rights, "MEMBER", request.member());
        putRole(rights, "GUEST", request.guest());
        return rights;
    }

    public static SyncResponse toResponse(SyncView view) {
        List<SyncChatState> chats = view.chats().stream()
                .map(chat -> new SyncChatState(chat.chatId(), chat.lastSeq(), chat.unreadCount()))
                .toList();
        return new SyncResponse(view.serverTime(), chats);
    }

    private static ChatRolePermissionsResponse toRolePermissions(
            Map<String, Boolean> values) {
        return new ChatRolePermissionsResponse(
                Boolean.TRUE.equals(values.get("post_messages")),
                Boolean.TRUE.equals(values.get("invite_members")),
                Boolean.TRUE.equals(values.get("create_polls")),
                Boolean.TRUE.equals(values.get("start_calls")),
                Boolean.TRUE.equals(values.get("pin_messages")),
                Boolean.TRUE.equals(values.get("change_info")));
    }

    private static void putRole(Map<String, Map<String, Boolean>> rights, String role,
                                ChatRolePermissionsRequest request) {
        if (request == null) {
            return;
        }
        Map<String, Boolean> values = new LinkedHashMap<>();
        put(values, "post_messages", request.postMessages());
        put(values, "invite_members", request.inviteMembers());
        put(values, "create_polls", request.createPolls());
        put(values, "start_calls", request.startCalls());
        put(values, "pin_messages", request.pinMessages());
        put(values, "change_info", request.changeInfo());
        rights.put(role, values);
    }

    private static void put(Map<String, Boolean> values, String permission, Boolean allowed) {
        if (allowed != null) {
            values.put(permission, allowed);
        }
    }
}
