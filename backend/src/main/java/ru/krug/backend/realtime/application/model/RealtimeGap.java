package ru.krug.backend.realtime.application.model;

import java.util.UUID;

/** Replay cannot cover the whole gap; the client must catch up through REST. */
public record RealtimeGap(UUID chatId, long fromSeq, long toSeq, String reason) {

    public static RealtimeGap retentionWindow(UUID chatId, long fromSeq, long toSeq) {
        return new RealtimeGap(chatId, fromSeq, toSeq, "RETENTION_WINDOW");
    }
}
