package ru.krug.backend.message.domain.model;

import java.util.Objects;

/**
 * Aggregated reaction of one emoji on one message. {@code count} is the number of unique
 * users, {@code me} is relative to the requesting user and is therefore never part of a
 * shared/cached value.
 */
public record MessageReaction(String emoji, long count, boolean me) {

    public MessageReaction {
        Objects.requireNonNull(emoji, "emoji");
        if (emoji.isEmpty()) {
            throw new IllegalArgumentException("emoji must not be empty");
        }
        if (count < 1) {
            throw new IllegalArgumentException("reaction count must be >= 1");
        }
    }
}
