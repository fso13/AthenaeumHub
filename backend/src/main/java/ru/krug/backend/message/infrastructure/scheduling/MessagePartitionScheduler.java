package ru.krug.backend.message.infrastructure.scheduling;

import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import ru.krug.backend.message.application.usecase.MessagePartitionHandler;

/**
 * Infrastructure trigger only: the transaction belongs to the application handler.
 */
@Component
public class MessagePartitionScheduler {

    private final MessagePartitionHandler partitionHandler;

    public MessagePartitionScheduler(MessagePartitionHandler partitionHandler) {
        this.partitionHandler = partitionHandler;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void ensureOnStartup() {
        partitionHandler.ensureUpcoming(2);
    }

    @Scheduled(cron = "0 10 0 * * *")
    public void ensureDaily() {
        partitionHandler.ensureUpcoming(3);
    }
}
