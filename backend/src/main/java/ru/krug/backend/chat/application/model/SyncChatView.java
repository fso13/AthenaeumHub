package ru.krug.backend.chat.application.model;

import java.util.UUID;

public record SyncChatView(UUID chatId, long lastSeq, long unreadCount) {
}
