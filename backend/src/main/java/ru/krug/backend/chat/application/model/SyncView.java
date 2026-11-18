package ru.krug.backend.chat.application.model;

import java.time.Instant;
import java.util.List;

public record SyncView(Instant serverTime, List<SyncChatView> chats) {
}
