package ru.krug.backend.message.api.mapper;

import ru.krug.backend.message.api.dto.MentionPageResponse;
import ru.krug.backend.message.api.dto.MentionResponse;
import ru.krug.backend.message.application.model.MentionInboxRow;
import ru.krug.backend.message.application.model.MentionPageView;

/** Mention application view -> API DTO. */
public final class MentionApiMapper {

    private MentionApiMapper() {
    }

    public static MentionPageResponse toResponse(MentionPageView view) {
        return new MentionPageResponse(view.items().stream().map(MentionApiMapper::toResponse)
                .toList(), new MentionPageResponse.Page(view.nextCursor(), view.hasMore()),
                view.unreadCount());
    }

    private static MentionResponse toResponse(MentionInboxRow row) {
        return new MentionResponse(row.id(), row.chatId(), row.chatName(), row.messageId(),
                row.senderId(), row.senderDisplayName(), row.mentionAll(), row.readAt(),
                row.createdAt());
    }
}
