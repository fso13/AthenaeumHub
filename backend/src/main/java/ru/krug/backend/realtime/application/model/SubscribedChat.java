package ru.krug.backend.realtime.application.model;

import java.util.UUID;

/** Per-chat outcome of a subscribe request. A forbidden chat never leaks its existence. */
public record SubscribedChat(UUID chatId, boolean accepted, long serverLastSeq, String reason) {

    public static SubscribedChat accepted(UUID chatId, long serverLastSeq) {
        return new SubscribedChat(chatId, true, serverLastSeq, null);
    }

    public static SubscribedChat forbidden(UUID chatId) {
        return new SubscribedChat(chatId, false, 0L, "FORBIDDEN");
    }
}
