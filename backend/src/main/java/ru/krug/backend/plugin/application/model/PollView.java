package ru.krug.backend.plugin.application.model;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import ru.krug.backend.plugin.domain.model.Poll;

/** API-facing poll read model. No domain/persistence types leak past this point. */
public record PollView(UUID id, String question, List<PollOptionView> options, UUID creatorId,
                       boolean closed, Instant closedAt, Instant createdAt, UUID myOptionId,
                       long totalVotes) {

    public static PollView from(Poll poll) {
        return new PollView(poll.id(), poll.question(),
                poll.options().stream()
                        .map(option -> new PollOptionView(option.id(), option.text(),
                                option.position(), option.votes()))
                        .toList(),
                poll.creatorId(), poll.closed(), poll.closedAt(), poll.createdAt(),
                poll.myOptionId(), poll.totalVotes());
    }
}
