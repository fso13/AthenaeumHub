package ru.krug.backend.workspace.api.dto;

import java.time.Instant;
import java.util.UUID;

/** Response DTO for one content-free DLP decision event (contract {@code DlpEvent}). */
public record DlpEventResponse(
        UUID id,
        UUID policyId,
        String policyName,
        String action,
        UUID actorId,
        UUID chatId,
        Instant createdAt) {
}
