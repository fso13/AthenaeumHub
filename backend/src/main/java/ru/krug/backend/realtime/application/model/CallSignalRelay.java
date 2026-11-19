package ru.krug.backend.realtime.application.model;

import java.time.Instant;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/**
 * One validated signal together with its authenticated sender and the exact recipient
 * user ids resolved by the access gate (one peer for DIRECT, the named subset for GROUP).
 */
public record CallSignalRelay(
        UUID workspaceId,
        UUID chatId,
        Set<UUID> recipientUserIds,
        UUID fromUserId,
        UUID fromDeviceId,
        CallSignal signal,
        Instant ts) {

    public CallSignalRelay {
        Objects.requireNonNull(workspaceId, "workspaceId");
        Objects.requireNonNull(chatId, "chatId");
        recipientUserIds = Set.copyOf(recipientUserIds);
        Objects.requireNonNull(fromUserId, "fromUserId");
        Objects.requireNonNull(fromDeviceId, "fromDeviceId");
        Objects.requireNonNull(signal, "signal");
        Objects.requireNonNull(ts, "ts");
    }
}
