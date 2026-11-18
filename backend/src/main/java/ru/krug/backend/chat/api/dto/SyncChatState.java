package ru.krug.backend.chat.api.dto;

import java.util.UUID;

public record SyncChatState(UUID chatId, long lastSeq, long unreadCount) {
}
