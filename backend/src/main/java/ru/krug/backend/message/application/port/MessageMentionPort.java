package ru.krug.backend.message.application.port;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import ru.krug.backend.message.application.model.MentionPlan;
import ru.krug.backend.shared.application.model.Principal;

/**
 * Mention write path, called by the message send transaction. Validation runs before seq
 * allocation; the rows are written after the message row exists, in the same transaction.
 */
public interface MessageMentionPort {

    /**
     * Validates {@code mentions[]}/{@code @all} against ACTIVE chat membership and the
     * caller's role.
     *
     * @param chatRole the caller's ACTIVE chat role (from {@code ChatAccess})
     * @throws ru.krug.backend.shared.error.DomainException 422 for an unknown/non-member id
     *         or an over-limit list, 403 {@code MENTION_ALL_FORBIDDEN} for @all by a role
     *         that may not ping the whole chat
     */
    MentionPlan plan(Principal principal, UUID workspaceId, UUID chatId, String chatRole,
                     List<UUID> mentionIds, boolean mentionAll);

    /** Persists the per-recipient inbox rows for a message that was just inserted. */
    void record(UUID workspaceId, UUID chatId, UUID messageId, MentionPlan plan, Instant now);
}
