package ru.krug.backend.message.application.usecase;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.port.ChatMemberDirectoryPort;
import ru.krug.backend.message.application.model.MentionPlan;
import ru.krug.backend.message.application.port.MessageMentionPort;
import ru.krug.backend.message.domain.model.MessageMention;
import ru.krug.backend.message.domain.repository.MessageMentionRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Write-side mention pipeline (#83).
 *
 * <p>Validation is deliberately strict and runs before {@code seq} allocation:
 * <ul>
 *   <li>at most {@value #MAX_MENTIONS} unique ids;</li>
 *   <li>every id must be an ACTIVE member of the target chat (a workspace member who is not
 *       in a private chat cannot be mentioned, and the response does not reveal whether the
 *       id exists);</li>
 *   <li>{@code @all} is restricted to chat OWNER/ADMIN — the broad ping is a moderation
 *       right, not a default member capability.</li>
 * </ul>
 *
 * <p>The sender is never a recipient of their own mention. {@code @all} is materialised for
 * the active member set at send time; rows are written in the message transaction, so a
 * message and its mentions commit or roll back together.
 */
@Service
public class MessageMentionService implements MessageMentionPort {

    static final int MAX_MENTIONS = 50;

    private static final Set<String> ALL_ROLES = Set.of("OWNER", "ADMIN");

    private final ChatMemberDirectoryPort chatDirectory;
    private final MessageMentionRepository mentions;

    public MessageMentionService(ChatMemberDirectoryPort chatDirectory,
                                 MessageMentionRepository mentions) {
        this.chatDirectory = chatDirectory;
        this.mentions = mentions;
    }

    @Override
    @Transactional(readOnly = true)
    public MentionPlan plan(Principal principal, UUID workspaceId, UUID chatId, String chatRole,
                            List<UUID> mentionIds, boolean mentionAll) {
        List<UUID> explicit = normalize(mentionIds);
        if (!mentionAll && explicit.isEmpty()) {
            return MentionPlan.empty();
        }
        if (explicit.size() > MAX_MENTIONS) {
            throw DomainException.unprocessable(ErrorCode.VALIDATION_FAILED,
                    "Too many mentions", Map.of("field", "mentions", "limit", MAX_MENTIONS,
                            "actual", explicit.size()));
        }
        if (mentionAll && !ALL_ROLES.contains(chatRole)) {
            throw DomainException.forbidden(ErrorCode.MENTION_ALL_FORBIDDEN,
                    "@all may only be used by a chat owner or admin",
                    Map.of("field", "mention_all", "role", chatRole));
        }
        var directory = chatDirectory.find(workspaceId, chatId).orElse(null);
        if (directory == null) {
            // The chat disappeared between the access check and this read; hide it.
            throw DomainException.notFound("Chat is not available");
        }
        List<UUID> active = directory.activeMemberIds();
        Set<UUID> recipients = new LinkedHashSet<>();
        if (mentionAll) {
            recipients.addAll(active);
        }
        for (UUID id : explicit) {
            if (!active.contains(id)) {
                // Do not disclose whether the id is a user, a member or a stranger.
                throw DomainException.unprocessable(ErrorCode.MENTION_INVALID,
                        "mentions must reference active members of this chat",
                        Map.of("field", "mentions"));
            }
            recipients.add(id);
        }
        recipients.remove(principal.userId());
        return new MentionPlan(explicit, List.copyOf(recipients), mentionAll);
    }

    @Override
    @Transactional
    public void record(UUID workspaceId, UUID chatId, UUID messageId, MentionPlan plan,
                       Instant now) {
        if (plan == null || plan.recipientIds().isEmpty()) {
            return;
        }
        List<MessageMention> rows = new ArrayList<>(plan.recipientIds().size());
        for (UUID recipient : plan.recipientIds()) {
            rows.add(MessageMention.create(UUID.randomUUID(), workspaceId, chatId, messageId,
                    recipient, plan.all(), now));
        }
        mentions.saveAll(rows);
    }

    private static List<UUID> normalize(List<UUID> mentionIds) {
        if (mentionIds == null || mentionIds.isEmpty()) {
            return List.of();
        }
        LinkedHashSet<UUID> unique = new LinkedHashSet<>();
        for (UUID id : mentionIds) {
            if (id != null) {
                unique.add(id);
            }
        }
        return List.copyOf(unique);
    }
}
