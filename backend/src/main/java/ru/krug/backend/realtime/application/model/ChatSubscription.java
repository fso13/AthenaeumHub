package ru.krug.backend.realtime.application.model;

import java.util.Objects;
import java.util.UUID;

/** Client-requested chat subscription with the last seq the client has already applied. */
public record ChatSubscription(UUID chatId, long lastSeq) {

    public ChatSubscription {
        Objects.requireNonNull(chatId, "chatId");
        if (lastSeq < 0) {
            throw new IllegalArgumentException("lastSeq must be >= 0");
        }
    }
}
