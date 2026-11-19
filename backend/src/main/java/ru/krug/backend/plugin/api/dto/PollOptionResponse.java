package ru.krug.backend.plugin.api.dto;

import java.util.UUID;

/** One option of {@code PollResponse}. */
public record PollOptionResponse(UUID id, String text, int position, long votes) {
}
