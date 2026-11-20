package ru.krug.backend.message.application.model;

import java.util.List;
import java.util.UUID;

/**
 * Validated mention intent for one message.
 *
 * @param mentionedUserIds explicit ids from {@code MessageCreate.mentions[]} (deduplicated,
 *                         in request order); stored on the message for rendering
 * @param recipientIds     everyone who gets an inbox row / MENTION notification: explicit
 *                         recipients plus (for @all) all active members except the sender
 * @param all              whether {@code @all} was requested
 */
public record MentionPlan(
        List<UUID> mentionedUserIds,
        List<UUID> recipientIds,
        boolean all) {

    public MentionPlan {
        mentionedUserIds = mentionedUserIds == null ? List.of()
                : List.copyOf(mentionedUserIds);
        recipientIds = recipientIds == null ? List.of() : List.copyOf(recipientIds);
    }

    public static MentionPlan empty() {
        return new MentionPlan(List.of(), List.of(), false);
    }

    public boolean isEmpty() {
        return mentionedUserIds.isEmpty() && recipientIds.isEmpty() && !all;
    }

    public boolean hasMentions() {
        return all || !mentionedUserIds.isEmpty();
    }
}
