package ru.krug.backend.realtime.application.model;

import java.util.List;

/**
 * Prepared subscribe response. The transport sends {@code subscribed} first, then hands the
 * plan to the hub, which enqueues replay under the per-chat lock and only then registers the
 * live subscription (no messages can slip between replay and live).
 */
public record SubscriptionPlan(
        String sessionId,
        List<SubscribedChat> chats,
        List<ReplayBatch> replays,
        boolean presence) {

    public SubscriptionPlan {
        chats = List.copyOf(chats);
        replays = List.copyOf(replays);
    }
}
