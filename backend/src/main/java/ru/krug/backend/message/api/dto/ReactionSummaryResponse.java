package ru.krug.backend.message.api.dto;

/** OpenAPI {@code ReactionSummary}: one emoji aggregate, relative to the caller. */
public record ReactionSummaryResponse(String emoji, long count, boolean me) {
}
