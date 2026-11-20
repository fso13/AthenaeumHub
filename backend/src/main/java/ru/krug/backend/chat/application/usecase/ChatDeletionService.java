package ru.krug.backend.chat.application.usecase;

import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.chat.application.model.ChatMembershipContext;
import ru.krug.backend.chat.domain.model.ChatMember;
import ru.krug.backend.chat.domain.repository.ChatRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;

/**
 * {@code DELETE /chats/{chatId}} (P0-2 / #80): soft delete by the channel OWNER.
 *
 * <p>The row keeps its messages, files and participant history; {@code deleted_at} hides the
 * channel from every list and access path (the shared {@code settings_scope} lookup already
 * filters deleted chats, so a repeat delete is a 404 instead of a second audit event). The
 * cover reference is cleared in the same statement ("cover cleanup on delete") while the
 * attachment row itself is left to normal file retention. DIRECT chats answer
 * {@code 422 CHAT_MEMBERSHIP_UNSUPPORTED}; leaving is a separate, unchanged endpoint.</p>
 */
@Service
public class ChatDeletionService {

    static final String ACTION = "chat.deleted";

    private final ChatMemberAccessService access;
    private final ChatRepository chatRepository;
    private final AuditPort audit;
    private final ClockPort clock;

    public ChatDeletionService(ChatMemberAccessService access, ChatRepository chatRepository,
                               AuditPort audit, ClockPort clock) {
        this.access = access;
        this.chatRepository = chatRepository;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public void delete(Principal principal, UUID chatId) {
        ChatMembershipContext context = access.resolve(principal, chatId);
        context.chat().requireChannelMembership();
        ChatMember actor = access.requireParticipant(context);
        if (actor.role() != ChatMember.Role.OWNER) {
            throw DomainException.forbidden(
                    "Only the channel OWNER can delete the channel");
        }
        if (!chatRepository.softDeleteChat(context.workspaceId(), chatId)) {
            throw DomainException.notFound("Chat not found");
        }
        audit.append(new AuditRecord(context.workspaceId(), principal.userId(), ACTION, "chat",
                chatId, principal.requestId(), Map.of("chat_type", "GROUP"), clock.now()));
    }
}
