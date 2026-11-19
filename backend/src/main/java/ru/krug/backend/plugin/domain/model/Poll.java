package ru.krug.backend.plugin.domain.model;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import ru.krug.backend.plugin.domain.service.PluginTextPolicy;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Chat-scoped poll aggregate. The creator is the only user allowed to close it; every
 * ACTIVE chat member may vote. A poll always has 2..10 unique plain-text options.
 */
public final class Poll {

    public static final int MIN_OPTIONS = 2;
    public static final int MAX_OPTIONS = 10;

    private final UUID id;
    private final UUID workspaceId;
    private final UUID chatId;
    private final UUID creatorId;
    private final String question;
    private final List<PollOption> options;
    private final UUID myOptionId;
    private final boolean closed;
    private final Instant closedAt;
    private final Instant createdAt;
    private final long totalVotes;

    private Poll(UUID id, UUID workspaceId, UUID chatId, UUID creatorId, String question,
                 List<PollOption> options, UUID myOptionId, boolean closed, Instant closedAt,
                 Instant createdAt, long totalVotes) {
        this.id = Objects.requireNonNull(id, "id");
        this.workspaceId = Objects.requireNonNull(workspaceId, "workspaceId");
        this.chatId = Objects.requireNonNull(chatId, "chatId");
        this.creatorId = Objects.requireNonNull(creatorId, "creatorId");
        this.question = Objects.requireNonNull(question, "question");
        this.options = List.copyOf(options);
        this.myOptionId = myOptionId;
        this.closed = closed;
        this.closedAt = closedAt;
        this.createdAt = Objects.requireNonNull(createdAt, "createdAt");
        this.totalVotes = totalVotes;
        if (this.options.size() < MIN_OPTIONS || this.options.size() > MAX_OPTIONS) {
            throw new IllegalArgumentException("a poll must have 2..10 options");
        }
        if (closed != (closedAt != null)) {
            throw new IllegalArgumentException("closed and closedAt must agree");
        }
        if (totalVotes < 0) {
            throw new IllegalArgumentException("totalVotes must be >= 0");
        }
        if (myOptionId != null && options.stream().noneMatch(o -> o.id().equals(myOptionId))) {
            throw new IllegalArgumentException("myOptionId must belong to this poll");
        }
    }

    public static Poll create(UUID workspaceId, UUID chatId, UUID creatorId, String question,
                              List<String> optionTexts, Instant now, UUIDGenerator ids) {
        Objects.requireNonNull(now, "now");
        Objects.requireNonNull(ids, "ids");
        String safeQuestion = PluginTextPolicy.requireQuestion(question);
        if (optionTexts == null || optionTexts.size() < MIN_OPTIONS
                || optionTexts.size() > MAX_OPTIONS) {
            throw DomainException.unprocessable(ErrorCode.VALIDATION_FAILED,
                    "A poll must have 2..10 options",
                    java.util.Map.of("field", "options"));
        }
        List<PollOption> options = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < optionTexts.size(); i++) {
            String text = PluginTextPolicy.requireOption(optionTexts.get(i));
            if (!seen.add(text)) {
                throw DomainException.unprocessable(ErrorCode.VALIDATION_FAILED,
                        "Poll options must be unique",
                        java.util.Map.of("field", "options"));
            }
            options.add(new PollOption(ids.newId(), text, i, 0));
        }
        return new Poll(ids.newId(), workspaceId, chatId, creatorId, safeQuestion, options,
                null, false, null, now, 0);
    }

    public static Poll reconstitute(UUID id, UUID workspaceId, UUID chatId, UUID creatorId,
                                    String question, List<PollOption> options, UUID myOptionId,
                                    boolean closed, Instant closedAt, Instant createdAt,
                                    long totalVotes) {
        return new Poll(id, workspaceId, chatId, creatorId, question, options, myOptionId,
                closed, closedAt, createdAt, totalVotes);
    }

    public UUID id() {
        return id;
    }

    public UUID workspaceId() {
        return workspaceId;
    }

    public UUID chatId() {
        return chatId;
    }

    public UUID creatorId() {
        return creatorId;
    }

    public String question() {
        return question;
    }

    public List<PollOption> options() {
        return options;
    }

    public UUID myOptionId() {
        return myOptionId;
    }

    public boolean closed() {
        return closed;
    }

    public Instant closedAt() {
        return closedAt;
    }

    public Instant createdAt() {
        return createdAt;
    }

    public long totalVotes() {
        return totalVotes;
    }

    public boolean isCreator(UUID userId) {
        return creatorId.equals(userId);
    }

    public boolean hasOption(UUID optionId) {
        return optionId != null && options.stream().anyMatch(o -> o.id().equals(optionId));
    }

    public Optional<PollOption> option(UUID optionId) {
        return options.stream().filter(o -> o.id().equals(optionId)).findFirst();
    }

    /** Application-side id source; keeps the domain free of {@code UUID.randomUUID}. */
    @FunctionalInterface
    public interface UUIDGenerator {
        UUID newId();
    }
}
