package ru.krug.backend.message.application.model;

/** Application result for a single reaction aggregate (POST response). */
public record ReactionSummaryView(String emoji, long count, boolean me) {
}
