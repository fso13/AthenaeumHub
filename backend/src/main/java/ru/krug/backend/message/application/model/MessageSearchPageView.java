package ru.krug.backend.message.application.model;

import java.util.List;

/** One page of server-side message search results. */
public record MessageSearchPageView(
        List<MessageSearchHitView> items,
        String nextCursor,
        boolean hasMore,
        int scanned) {

    public MessageSearchPageView {
        items = items == null ? List.of() : List.copyOf(items);
    }
}
