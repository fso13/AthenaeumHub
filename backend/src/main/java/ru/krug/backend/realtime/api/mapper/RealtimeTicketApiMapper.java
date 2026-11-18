package ru.krug.backend.realtime.api.mapper;

import ru.krug.backend.realtime.api.dto.RealtimeTicketResponse;
import ru.krug.backend.realtime.application.model.IssuedRealtimeTicket;

/** Application result -> API DTO. The API layer never imports domain/infrastructure. */
public final class RealtimeTicketApiMapper {

    private RealtimeTicketApiMapper() {
    }

    public static RealtimeTicketResponse toResponse(IssuedRealtimeTicket ticket) {
        return new RealtimeTicketResponse(ticket.ticket(), ticket.expiresAt(), ticket.wsUrl());
    }
}
