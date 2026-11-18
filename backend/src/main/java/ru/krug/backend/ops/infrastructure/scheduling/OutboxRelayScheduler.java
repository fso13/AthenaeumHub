package ru.krug.backend.ops.infrastructure.scheduling;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import ru.krug.backend.ops.application.usecase.OutboxRelayService;

@Component
@ConditionalOnProperty(name = "krug.outbox.relay.enabled", havingValue = "true")
public class OutboxRelayScheduler {

    private final OutboxRelayService relayService;

    public OutboxRelayScheduler(OutboxRelayService relayService) {
        this.relayService = relayService;
    }

    @Scheduled(fixedDelayString = "${krug.outbox.relay.poll-interval:2s}")
    public void publish() {
        relayService.publishPending();
    }
}
