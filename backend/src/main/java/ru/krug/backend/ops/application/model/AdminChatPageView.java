package ru.krug.backend.ops.application.model;

import java.util.List;

/** One cursor page of admin chats plus the opaque cursor of the next page. */
public record AdminChatPageView(List<AdminChatView> items, String nextCursor, boolean hasMore) {
}
