package ru.krug.backend.notification.application.usecase;

import java.time.Duration;
import java.time.Instant;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.notification.application.port.NotificationRetentionSettings;
import ru.krug.backend.notification.domain.repository.NotificationRepository;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.WorkerContext;

/** One bounded retention deletion batch per transaction. */
@Service
public class NotificationRetentionBatch {

    private final WorkerContext workerContext;
    private final NotificationRepository notifications;
    private final NotificationRetentionSettings settings;
    private final ClockPort clock;

    public NotificationRetentionBatch(WorkerContext workerContext,
                                      NotificationRepository notifications,
                                      NotificationRetentionSettings settings,
                                      ClockPort clock) {
        this.workerContext = workerContext;
        this.notifications = notifications;
        this.settings = settings;
        this.clock = clock;
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public int deleteBatch() {
        workerContext.activate(WorkerContext.WorkerRole.NOTIFICATION_RETENTION);
        Instant cutoff = clock.now().minus(Duration.ofDays(settings.retentionDays()));
        return notifications.deleteCreatedBefore(cutoff, settings.batchSize());
    }
}
