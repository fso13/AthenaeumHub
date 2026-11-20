package ru.krug.backend.message.api.dto;

import java.util.UUID;

/** Poll option embedded into a POLL message; field names match OpenAPI {@code PollOption}. */
public record MessagePollOptionResponse(UUID id, String text, int position, long votes) {
}
