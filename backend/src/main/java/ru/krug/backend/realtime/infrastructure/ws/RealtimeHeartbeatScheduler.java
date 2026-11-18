package ru.krug.backend.realtime.infrastructure.ws;

import java.time.Instant;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class RealtimeHeartbeatScheduler {

    private final InMemoryRealtimeHub hub;

    public RealtimeHeartbeatScheduler(InMemoryRealtimeHub hub) {
        this.hub = hub;
    }

    @Scheduled(fixedDelayString = "${krug.realtime.heartbeat-interval:25s}")
    public void heartbeat() {
        hub.heartbeat(Instant.now());
    }
}
