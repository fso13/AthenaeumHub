package ru.krug.backend.realtime.domain.repository;

import java.time.Instant;
import java.util.Optional;

import ru.krug.backend.realtime.domain.model.RealtimeTicket;
import ru.krug.backend.realtime.domain.model.TicketId;
import ru.krug.backend.realtime.domain.model.TicketTokenHash;

public interface RealtimeTicketRepository {

    void save(RealtimeTicket ticket);

    Optional<RealtimeTicket> findByTokenHash(TicketTokenHash tokenHash);

    /**
     * Atomically marks the ticket consumed. Returns false when the ticket was already
     * consumed, expired, or does not exist, so concurrent handshakes cannot both win.
     */
    boolean consume(TicketId id, Instant now);

    /**
     * Deletes one batch of tickets whose {@code expires_at} or {@code consumed_at} is older
     * than the cutoff. Returns the number of removed rows.
     */
    int deleteExpired(Instant cutoff, int batchSize);
}
