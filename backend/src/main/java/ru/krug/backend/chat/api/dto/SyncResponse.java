package ru.krug.backend.chat.api.dto;

import java.time.Instant;
import java.util.List;

public record SyncResponse(Instant serverTime, List<SyncChatState> chats) {
}
