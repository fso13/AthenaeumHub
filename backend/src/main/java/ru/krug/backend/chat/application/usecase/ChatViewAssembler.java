package ru.krug.backend.chat.application.usecase;

import java.time.Instant;
import java.util.UUID;

import org.springframework.stereotype.Component;

import ru.krug.backend.chat.application.model.ChatView;
import ru.krug.backend.chat.domain.model.ChannelJoinPolicy;
import ru.krug.backend.chat.domain.model.ChannelSettings;
import ru.krug.backend.chat.domain.model.ChannelVisibility;
import ru.krug.backend.chat.domain.model.Chat;
import ru.krug.backend.chat.domain.model.ChatSummary;
import ru.krug.backend.chat.domain.repository.ChatRepository;

/**
 * Builds the contract {@code Chat} view from a chat row (P0-2). When the viewer is an ACTIVE
 * participant the personal summary (unread counter, archive flag) is used; a workspace
 * OWNER/ADMIN who is not a member still gets a valid settings view without a personal
 * counter.
 */
@Component
public class ChatViewAssembler {

    private final ChatRepository chatRepository;

    public ChatViewAssembler(ChatRepository chatRepository) {
        this.chatRepository = chatRepository;
    }

    public ChatView toView(Chat chat, UUID viewerId) {
        ChatSummary summary = chatRepository
                .listActiveSummaries(chat.workspaceId(), viewerId).stream()
                .filter(item -> item.id().equals(chat.id()))
                .findFirst()
                .orElse(null);
        if (summary != null) {
            ChannelVisibility visibility = summary.visibility();
            return new ChatView(summary.id(), summary.type().name(),
                    summary.securityMode().name(),
                    visibility == null ? null : visibility.name(), summary.peerId(),
                    summary.peerHasE2eeCapableDevices(), summary.name(),
                    summary.description(), null, summary.lastSeq(), summary.unreadCount(),
                    summary.createdAt(), summary.coverFileId(), summary.readOnly(),
                    summary.joinPolicy() == null ? null : summary.joinPolicy().name(),
                    summary.archived());
        }
        ChannelSettings settings = chatRepository
                .findChannelSettings(chat.workspaceId(), chat.id())
                .orElseGet(ChannelSettings::defaults);
        ChannelVisibility visibility = chat.type() == Chat.Type.GROUP
                ? chatRepository.findChannelVisibility(chat.workspaceId(), chat.id())
                        .orElse(null)
                : null;
        String joinPolicy = chat.type() == Chat.Type.GROUP
                ? settings.joinPolicy().name() : null;
        return new ChatView(chat.id(), chat.type().name(), chat.securityMode().name(),
                visibility == null ? null : visibility.name(), null, false, chat.name(),
                chat.description(), null, chatRepository.lastSeq(chat.id()), 0,
                chat.createdAt(), settings.coverFileId(), settings.readOnly(), joinPolicy,
                false);
    }

    /** Convenience for the freshly created GROUP channel before any summary row exists. */
    public static ChatView createdGroup(Chat chat, ChannelVisibility visibility,
                                        ChannelJoinPolicy joinPolicy, Instant createdAt) {
        return new ChatView(chat.id(), "GROUP", chat.securityMode().name(),
                visibility == null ? null : visibility.name(), null, false, chat.name(),
                chat.description(), null, 0, 0, createdAt, null, false,
                joinPolicy == null ? null : joinPolicy.name(), false);
    }

    /** Convenience for the freshly created DIRECT chat. */
    public static ChatView createdDirect(Chat chat, UUID peerId, boolean peerCapable,
                                         Instant createdAt) {
        return new ChatView(chat.id(), "DIRECT", chat.securityMode().name(), null, peerId,
                peerCapable, null, null, null, 0, 0, createdAt, null, false, null, false);
    }
}
