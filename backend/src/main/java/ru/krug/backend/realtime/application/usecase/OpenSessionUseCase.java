package ru.krug.backend.realtime.application.usecase;

import java.time.Instant;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.realtime.application.model.RealtimeSession;
import ru.krug.backend.realtime.domain.exception.RealtimeTicketInvalidException;
import ru.krug.backend.realtime.domain.model.RealtimeTicket;
import ru.krug.backend.realtime.domain.model.TicketToken;
import ru.krug.backend.realtime.domain.repository.RealtimeTicketRepository;
import ru.krug.backend.shared.application.port.ClockPort;

/**
 * Consumes a ticket during the WS handshake. Consumption is a single atomic UPDATE, so a
 * concurrent second handshake with the same ticket loses and receives 401/close 4401.
 */
@Service
public class OpenSessionUseCase {

    private final RealtimeTicketRepository ticketRepository;
    private final ClockPort clock;

    public OpenSessionUseCase(RealtimeTicketRepository ticketRepository, ClockPort clock) {
        this.ticketRepository = ticketRepository;
        this.clock = clock;
    }

    @Transactional
    public RealtimeSession open(String rawToken) {
        TicketToken token = parse(rawToken);
        RealtimeTicket ticket = ticketRepository.findByTokenHash(token.hash())
                .orElseThrow(() -> invalid("Ticket is unknown"));
        Instant now = clock.now();
        if (ticket.isConsumed()) {
            throw invalid("Ticket has already been used");
        }
        if (ticket.isExpired(now)) {
            throw invalid("Ticket has expired");
        }
        if (!ticketRepository.consume(ticket.id(), now)) {
            throw invalid("Ticket has already been used");
        }
        return RealtimeSession.open(ticket.userId(), ticket.deviceId(), ticket.workspaceId(), now);
    }

    private static TicketToken parse(String raw) {
        try {
            return TicketToken.of(raw);
        } catch (RuntimeException ex) {
            throw invalid("Ticket is malformed");
        }
    }

    private static RealtimeTicketInvalidException invalid(String message) {
        return new RealtimeTicketInvalidException(message);
    }
}
