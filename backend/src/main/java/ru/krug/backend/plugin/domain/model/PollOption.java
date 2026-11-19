package ru.krug.backend.plugin.domain.model;

import java.util.Objects;
import java.util.UUID;

/**
 * One option of a poll. {@code votes} is the number of distinct users that currently
 * selected this option; editing a vote moves it between options instead of adding a row.
 */
public record PollOption(UUID id, String text, int position, long votes) {

    public PollOption {
        Objects.requireNonNull(id, "id");
        Objects.requireNonNull(text, "text");
        if (position < 0 || position > 9) {
            throw new IllegalArgumentException("position must be 0..9");
        }
        if (votes < 0) {
            throw new IllegalArgumentException("votes must be >= 0");
        }
    }
}
