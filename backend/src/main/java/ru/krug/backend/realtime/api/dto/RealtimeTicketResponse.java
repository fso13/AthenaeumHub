package ru.krug.backend.realtime.api.dto;

import java.time.Instant;

public record RealtimeTicketResponse(String ticket, Instant expiresAt, String wsUrl) {
}
