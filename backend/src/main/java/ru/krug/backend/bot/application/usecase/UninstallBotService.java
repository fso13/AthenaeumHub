package ru.krug.backend.bot.application.usecase;

import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.bot.application.model.BotChatAccess;
import ru.krug.backend.bot.application.port.BotChatAccessPort;
import ru.krug.backend.bot.domain.repository.ChatBotRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;

/**
 * {@code DELETE /chats/{chatId}/bots/{botId}} (chat OWNER/ADMIN). Removes the installation
 * row; a later send is refused. Idempotent: a missing row is a 204 no-op without audit.
 */
@Service
public class UninstallBotService {

    static final String ACTION = "chat.bot.uninstalled";

    private final BotChatAccessPort chatAccess;
    private final ChatBotRepository chatBots;
    private final AuditPort audit;
    private final ClockPort clock;

    public UninstallBotService(BotChatAccessPort chatAccess, ChatBotRepository chatBots,
                               AuditPort audit, ClockPort clock) {
        this.chatAccess = chatAccess;
        this.chatBots = chatBots;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public void uninstall(Principal principal, UUID chatId, UUID botId) {
        BotChatAccess access = chatAccess.requireActiveChat(principal, chatId);
        if (!access.canManage()) {
            throw DomainException.forbidden(
                    "Only an active chat OWNER or ADMIN can remove bots");
        }
        boolean removed = chatBots.uninstall(access.workspaceId(), chatId, botId);
        if (removed) {
            audit.append(new AuditRecord(access.workspaceId(), principal.userId(), ACTION,
                    "chat", chatId, principal.requestId(),
                    Map.of("bot_id", botId.toString()), clock.now()));
        }
    }
}
