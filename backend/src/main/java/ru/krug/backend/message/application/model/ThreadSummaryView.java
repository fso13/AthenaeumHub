package ru.krug.backend.message.application.model;

import java.time.Instant;
import java.util.UUID;

import ru.krug.backend.message.domain.model.ThreadSummary;

/**
 * Read model for {@code Message.thread_summary}. Percent-encoded/free-form text is not
 * interpreted anywhere; the API mapper writes it as a plain string.
 */
public record ThreadSummaryView(
        long replyCount,
        Instant lastReplyAt,
        UUID lastReplyAuthorId,
        String lastReplyExcerpt) {

    public static ThreadSummaryView from(ThreadSummary summary) {
        return new ThreadSummaryView(summary.replyCount(), summary.lastReplyAt(),
                summary.lastReplyAuthorId(), summary.lastReplyExcerpt());
    }
}
