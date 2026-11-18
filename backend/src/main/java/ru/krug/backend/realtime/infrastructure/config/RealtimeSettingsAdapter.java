package ru.krug.backend.realtime.infrastructure.config;

import java.time.Duration;

import org.springframework.stereotype.Component;

import ru.krug.backend.realtime.application.port.RealtimeSettingsPort;

@Component
public class RealtimeSettingsAdapter implements RealtimeSettingsPort {

    private final RealtimeProperties properties;

    public RealtimeSettingsAdapter(RealtimeProperties properties) {
        this.properties = properties;
    }

    @Override
    public String wsUrl() {
        return properties.wsUrl();
    }

    @Override
    public Duration ticketTtl() {
        return properties.ticketTtl();
    }

    @Override
    public int maxSubscriptions() {
        return properties.maxSubscriptions();
    }

    @Override
    public int replayLimit() {
        return properties.replayLimit();
    }

    @Override
    public int outboundQueueCapacity() {
        return properties.outboundQueueCapacity();
    }

    @Override
    public Duration heartbeatInterval() {
        return properties.heartbeatInterval();
    }

    @Override
    public Duration heartbeatTimeout() {
        return properties.heartbeatTimeout();
    }

    @Override
    public Duration typingTtl() {
        return properties.typingTtl();
    }

    @Override
    public Duration presenceTtl() {
        return properties.presenceTtl();
    }
}
