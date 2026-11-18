package ru.krug.backend.realtime.application.usecase;

import java.time.Instant;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.realtime.domain.repository.RealtimeTicketRepository;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.RetentionSettings;

/** One bounded ticket deletion batch in its own transaction. */
@Service
public class RealtimeTicketRetentionBatch {

    private final RealtimeTicketRepository tickets;
    private final RetentionSettings settings;
    private final ClockPort clock;

    public RealtimeTicketRetentionBatch(RealtimeTicketRepository tickets,
                                        RetentionSettings settings, ClockPort clock) {
        this.tickets = tickets;
        this.settings = settings;
        this.clock = clock;
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public int deleteBatch() {
        Instant cutoff = clock.now().minus(settings.ticketRetention());
        return tickets.deleteExpired(cutoff, settings.batchSize());
    }
}
