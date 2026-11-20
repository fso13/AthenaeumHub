package ru.krug.backend.chat.api.mapper;

import java.util.List;

import ru.krug.backend.chat.api.dto.ChatListResponse;
import ru.krug.backend.chat.api.dto.ChatResponse;
import ru.krug.backend.chat.api.dto.ChatSummaryResponse;
import ru.krug.backend.chat.api.dto.SyncChatState;
import ru.krug.backend.chat.api.dto.SyncResponse;
import ru.krug.backend.chat.application.model.ChatListView;
import ru.krug.backend.chat.application.model.ChatSummaryView;
import ru.krug.backend.chat.application.model.ChatView;
import ru.krug.backend.chat.application.model.SyncView;

/**
 * Application result -> API DTO. The API layer never sees domain classes.
 */
public final class ChatApiMapper {

    private ChatApiMapper() {
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
                view.lastSeq());
    }

    public static ChatResponse toResponse(ChatView view) {
        return new ChatResponse(view.id(), view.type(), view.securityMode(), view.visibility(),
                view.peerId(), view.peerHasE2eeCapableDevices(), view.name(),
                view.description(), view.keyEpoch(), view.lastSeq(), view.unreadCount(),
                view.createdAt());
    }

    public static SyncResponse toResponse(SyncView view) {
        List<SyncChatState> chats = view.chats().stream()
                .map(chat -> new SyncChatState(chat.chatId(), chat.lastSeq(), chat.unreadCount()))
                .toList();
        return new SyncResponse(view.serverTime(), chats);
    }
}
