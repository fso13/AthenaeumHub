package ru.krug.backend.message.api.mapper;

import java.util.List;

import ru.krug.backend.message.api.dto.MessageSearchHitResponse;
import ru.krug.backend.message.api.dto.MessageSearchPageResponse;
import ru.krug.backend.message.api.dto.SearchHighlightResponse;
import ru.krug.backend.message.application.model.MessageSearchHitView;
import ru.krug.backend.message.application.model.MessageSearchPageView;

/** Application search view -> API DTO. */
public final class MessageSearchApiMapper {

    private MessageSearchApiMapper() {
    }

    public static MessageSearchPageResponse toResponse(MessageSearchPageView view, String query) {
        List<MessageSearchHitResponse> items = view.items().stream()
                .map(MessageSearchApiMapper::toResponse)
                .toList();
        return new MessageSearchPageResponse(items,
                new MessageSearchPageResponse.Page(view.nextCursor(), view.hasMore()), query);
    }

    private static MessageSearchHitResponse toResponse(MessageSearchHitView view) {
        return new MessageSearchHitResponse(view.messageId(), view.chatId(), view.chatName(),
                view.seq(), view.senderId(), view.senderDisplayName(), view.snippet(),
                view.highlights().stream()
                        .map(highlight -> new SearchHighlightResponse(highlight.start(),
                                highlight.end()))
                        .toList(),
                view.createdAt());
    }
}
