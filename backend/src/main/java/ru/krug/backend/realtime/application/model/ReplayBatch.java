package ru.krug.backend.realtime.application.model;

import java.util.List;
import java.util.UUID;

/** Replay window (and optional gap notice) prepared for one chat. */
public record ReplayBatch(UUID chatId, List<RealtimeEvent> events, RealtimeGap gap) {

    public ReplayBatch {
        events = List.copyOf(events);
    }
}
