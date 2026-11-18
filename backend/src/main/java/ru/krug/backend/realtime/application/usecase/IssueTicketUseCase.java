package ru.krug.backend.realtime.application.usecase;

import java.time.Instant;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.realtime.application.model.IssuedRealtimeTicket;
import ru.krug.backend.realtime.application.port.RealtimeDevicePort;
import ru.krug.backend.realtime.application.port.RealtimeSettingsPort;
import ru.krug.backend.realtime.domain.exception.RealtimeForbiddenException;
import ru.krug.backend.realtime.domain.exception.RealtimeTicketInvalidException;
import ru.krug.backend.realtime.domain.model.RealtimeTicket;
import ru.krug.backend.realtime.domain.model.TicketId;
import ru.krug.backend.realtime.domain.model.TicketToken;
import ru.krug.backend.realtime.domain.repository.RealtimeTicketRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;

/**
 * Issues a 30-second one-time ticket bound to the authenticated user, device, and (when
 * known) workspace. The device header is validated against the auth device registry; a
 * device owned by someone else is a 403, never a usable ticket.
 */
@Service
public class IssueTicketUseCase {

    private final RealtimeTicketRepository ticketRepository;
    private final RealtimeDevicePort devicePort;
    private final RealtimeSettingsPort settings;
    private final ClockPort clock;

    public IssueTicketUseCase(RealtimeTicketRepository ticketRepository,
                              RealtimeDevicePort devicePort, RealtimeSettingsPort settings,
                              ClockPort clock) {
        this.ticketRepository = ticketRepository;
        this.devicePort = devicePort;
        this.settings = settings;
        this.clock = clock;
    }

    @Transactional
    public IssuedRealtimeTicket issue(Principal principal, String deviceHeader) {
        UUID deviceId = parseDevice(deviceHeader);
        if (!devicePort.isActiveDeviceOfUser(deviceId, principal.userId())) {
            throw new RealtimeForbiddenException(
                    "Device is not registered to this user or is not ACTIVE");
        }

        TicketToken token = TicketToken.generate();
        Instant now = clock.now();
        RealtimeTicket ticket = RealtimeTicket.issue(TicketId.newId(), token.hash(),
                principal.userId(), deviceId, principal.workspaceId(), now,
                settings.ticketTtl());
        ticketRepository.save(ticket);
        return new IssuedRealtimeTicket(token.value(), ticket.expiresAt(), settings.wsUrl());
    }

    private static UUID parseDevice(String header) {
        if (header == null || header.isBlank()) {
            throw new RealtimeTicketInvalidException("X-Device-Id header is required");
        }
        try {
            return UUID.fromString(header.strip());
        } catch (IllegalArgumentException ex) {
            throw new RealtimeTicketInvalidException("X-Device-Id header must be a UUID");
        }
    }
}
