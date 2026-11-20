package ru.krug.backend.message.application.model;

import java.util.List;

/** One page of the caller's mention inbox plus the workspace unread counter. */
public record MentionPageView(
        List<MentionInboxRow> items,
        String nextCursor,
        boolean hasMore,
        long unreadCount) {

    public MentionPageView {
        items = items == null ? List.of() : List.copyOf(items);
    }
}
