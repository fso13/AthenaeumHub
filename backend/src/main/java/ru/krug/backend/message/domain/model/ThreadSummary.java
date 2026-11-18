package ru.krug.backend.message.domain.model;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * Server-computed summary of one flat thread. Only the root of the thread carries it.
 * {@code lastReplyExcerpt} is plaintext and therefore exists only for MANAGED replies;
 * E2EE threads are not supported, so the excerpt is always null there.
 */
public record ThreadSummary(
        UUID threadRootId,
        long replyCount,
        Instant lastReplyAt,
        UUID lastReplyAuthorId,
        String lastReplyExcerpt) {

    public static final int MAX_EXCERPT_LENGTH = 160;

    public ThreadSummary {
        Objects.requireNonNull(threadRootId, "threadRootId");
        if (replyCount < 0) {
            throw new IllegalArgumentException("replyCount must be >= 0");
        }
    }

    /** Summary of a root that has no live replies yet (the root still carries a summary). */
    public static ThreadSummary empty(UUID threadRootId) {
        return new ThreadSummary(threadRootId, 0, null, null, null);
    }

    /**
     * One-line preview for the thread root. Newlines/tabs are collapsed so a reply cannot
     * break the feed layout, and the result is truncated by Unicode code points (never in
     * the middle of a surrogate pair) to the OpenAPI {@code maxLength: 160}.
     */
    public static String excerpt(String text) {
        if (text == null) {
            return null;
        }
        String normalized = text.replaceAll("\\s+", " ").strip();
        if (normalized.isEmpty()) {
            return null;
        }
        int codePoints = normalized.codePointCount(0, normalized.length());
        if (codePoints <= MAX_EXCERPT_LENGTH) {
            return normalized;
        }
        return normalized.substring(0,
                normalized.offsetByCodePoints(0, MAX_EXCERPT_LENGTH));
    }
}
