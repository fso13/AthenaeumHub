package ru.krug.backend.message.application.model;

import java.util.UUID;

/** One option of a poll embedded into a POLL timeline message. */
public record EmbeddedPollOptionView(UUID id, String text, int position, long votes) {
}
