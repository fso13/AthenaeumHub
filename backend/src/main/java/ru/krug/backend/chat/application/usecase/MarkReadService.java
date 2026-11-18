package ru.krug.backend.chat.application.usecase;

import java.time.Instant;
import java.util.UUID;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.event.ReadReceiptNotification;
import ru.krug.backend.chat.application.model.ChatAccess;
import ru.krug.backend.chat.application.port.ChatAccessPort;
import ru.krug.backend.chat.application.port.ChatWorkspacePort;
import ru.krug.backend.chat.domain.repository.ChatRepository;
import ru.krug.backend.chat.domain.service.ChatReadPolicy;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;

@Service
public class MarkReadService {

    private final TenantContext tenantContext;
    private final ChatAccessPort chatAccess;
    private final ChatRepository chatRepository;
    private final ClockPort clock;
    private final ChatWorkspacePort chatWorkspace;
    private final ApplicationEventPublisher events;

    public MarkReadService(TenantContext tenantContext, ChatAccessPort chatAccess,
                           ChatRepository chatRepository, ClockPort clock,
                           ChatWorkspacePort chatWorkspace, ApplicationEventPublisher events) {
        this.tenantContext = tenantContext;
        this.chatAccess = chatAccess;
        this.chatRepository = chatRepository;
        this.clock = clock;
        this.chatWorkspace = chatWorkspace;
        this.events = events;
    }

    @Transactional
    public void markRead(Principal principal, UUID chatId, long lastSeq) {
        if (principal.workspaceId() == null) {
            principal = principal.withWorkspace(chatWorkspace.workspaceForChat(chatId,
                    principal.userId(), principal.requestId()));
        }
        tenantContext.activate(principal);
        ChatAccess access = chatAccess.requireActiveChat(principal.workspaceId(), chatId,
                principal.userId());
        ChatReadPolicy.ensureWithinTimeline(lastSeq, access.lastSeq());
        Instant now = clock.now();
        chatRepository.markRead(principal.workspaceId(), chatId, principal.userId(), lastSeq,
                now);
        events.publishEvent(new ReadReceiptNotification(principal.workspaceId(), chatId,
                principal.userId(), lastSeq, now));
    }
}
