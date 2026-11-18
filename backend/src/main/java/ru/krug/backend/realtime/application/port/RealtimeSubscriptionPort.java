package ru.krug.backend.realtime.application.port;

import ru.krug.backend.realtime.application.model.SubscriptionPlan;

/**
 * In-process subscription registry (single-node E3). {@code activate} must enqueue the
 * replay window and register the live subscription atomically with respect to publishing
 * for the same chat.
 */
public interface RealtimeSubscriptionPort {

    void activate(SubscriptionPlan plan);

    void deactivate(String sessionId);
}
