package ru.krug.backend.message.application.model;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * One search hit. {@code snippet} is plain text (the managed message body), never HTML;
 * {@code highlights} are character ranges inside it.
 */
public record MessageSearchHitView(
        UUID messageId,
        UUID chatId,
        String chatName,
        long seq,
        UUID senderId,
        String senderDisplayName,
        String snippet,
        List<SearchHighlightView> highlights,
        Instant createdAt) {

    public MessageSearchHitView {
        highlights = highlights == null ? List.of() : List.copyOf(highlights);
    }
}
