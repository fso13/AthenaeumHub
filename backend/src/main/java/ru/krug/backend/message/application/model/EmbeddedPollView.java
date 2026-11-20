package ru.krug.backend.message.application.model;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Viewer-relative projection of a poll embedded into a POLL message. {@code myOptionId} is
 * resolved for the caller who requested the page/frame, never for the poll creator.
 */
public record EmbeddedPollView(UUID id, String question, List<EmbeddedPollOptionView> options,
                               UUID creatorId, boolean closed, Instant closedAt,
                               Instant createdAt, UUID myOptionId, long totalVotes) {

    public EmbeddedPollView {
        options = options == null ? List.of() : List.copyOf(options);
    }
}
