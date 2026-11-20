package ru.krug.backend.chat.application.usecase;

import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.model.ChatMembershipContext;
import ru.krug.backend.chat.domain.repository.ChatRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;

/**
 * {@code POST /chats/{chatId}/archive} and {@code POST /unarchive} (P0-2 / #80).
 *
 * <p>The archive is deliberately user-local: only the caller's own view is hidden from the
 * main chat list, other participants are unaffected, and no audit/notification is produced
 * for a personal UI state. Any ACTIVE participant may archive, including a DIRECT chat. Both
 * operations are idempotent (204).</p>
 */
@Service
public class ChatArchiveService {

    private final ChatMemberAccessService access;
    private final ChatRepository chatRepository;
    private final ClockPort clock;

    public ChatArchiveService(ChatMemberAccessService access, ChatRepository chatRepository,
                              ClockPort clock) {
        this.access = access;
        this.chatRepository = chatRepository;
        this.clock = clock;
    }

    @Transactional
    public void archive(Principal principal, UUID chatId) {
        ChatMembershipContext context = access.resolve(principal, chatId);
        access.requireParticipant(context);
        chatRepository.archiveChat(context.workspaceId(), chatId, principal.userId(),
                clock.now());
    }

    @Transactional
    public void unarchive(Principal principal, UUID chatId) {
        ChatMembershipContext context = access.resolve(principal, chatId);
        access.requireParticipant(context);
        chatRepository.unarchiveChat(context.workspaceId(), chatId, principal.userId());
    }
}
