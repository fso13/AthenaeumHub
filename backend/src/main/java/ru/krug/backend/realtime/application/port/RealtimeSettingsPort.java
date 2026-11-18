package ru.krug.backend.realtime.application.port;

import java.time.Duration;

/** Runtime settings for the realtime slice, implemented by infrastructure config. */
public interface RealtimeSettingsPort {

    String wsUrl();

    Duration ticketTtl();

    int maxSubscriptions();

    int replayLimit();

    int outboundQueueCapacity();

    Duration heartbeatInterval();

    Duration heartbeatTimeout();

    Duration typingTtl();

    Duration presenceTtl();
}
