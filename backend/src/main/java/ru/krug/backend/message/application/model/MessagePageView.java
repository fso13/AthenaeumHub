package ru.krug.backend.message.application.model;

import java.util.List;

public record MessagePageView(List<MessageView> items, String nextCursor, boolean hasMore) {
}
