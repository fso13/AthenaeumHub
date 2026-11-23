package ru.krug.backend.bot.infrastructure.scheduling;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import ru.krug.backend.bot.application.usecase.BotEventDeliveryService;

/** Periodically drains the bot webhook outbox. Disabled in the shared integration profile. */
@Component
@ConditionalOnProperty(name = "krug.bots.events.worker-enabled", havingValue = "true",
        matchIfMissing = true)
public class BotEventDeliveryScheduler {

    private final BotEventDeliveryService deliveryService;

    public BotEventDeliveryScheduler(BotEventDeliveryService deliveryService) {
        this.deliveryService = deliveryService;
    }

    @Scheduled(fixedDelayString = "${krug.bots.events.poll-interval:1s}")
    public void deliver() {
        deliveryService.deliverDue();
    }
}
