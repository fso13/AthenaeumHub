package ru.krug.backend.bot.application.usecase;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.bot.application.model.BotChatAccess;
import ru.krug.backend.bot.application.model.BotView;
import ru.krug.backend.bot.application.model.ChatBotView;
import ru.krug.backend.bot.application.port.BotChatAccessPort;
import ru.krug.backend.bot.domain.model.Bot;
import ru.krug.backend.bot.domain.model.ChatBot;
import ru.krug.backend.bot.domain.repository.BotRepository;
import ru.krug.backend.bot.domain.repository.ChatBotRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * {@code POST /chats/{chatId}/bots} (chat OWNER/ADMIN). The bot must belong to the chat's
 * workspace, be ACTIVE and the chat must be MANAGED — a server-side bot has no place in an
 * E2EE chat. Installation is idempotent; only a real insert writes audit (ids only).
 */
@Service
public class InstallBotService {

    static final String ACTION = "chat.bot.installed";

    private final BotChatAccessPort chatAccess;
    private final BotRepository bots;
    private final ChatBotRepository chatBots;
    private final AuditPort audit;
    private final ClockPort clock;

    public InstallBotService(BotChatAccessPort chatAccess, BotRepository bots,
                             ChatBotRepository chatBots, AuditPort audit, ClockPort clock) {
        this.chatAccess = chatAccess;
        this.bots = bots;
        this.chatBots = chatBots;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public ChatBotView install(Principal principal, UUID chatId, UUID botId) {
        BotChatAccess access = chatAccess.requireActiveChat(principal, chatId);
        if (!access.canManage()) {
            throw DomainException.forbidden(
                    "Only an active chat OWNER or ADMIN can install bots");
        }
        if ("E2EE".equals(access.securityMode())) {
            throw DomainException.unprocessable(ErrorCode.BOT_E2EE_UNSUPPORTED,
                    "Bots are not available in an E2EE chat",
                    Map.of("reason", ErrorCode.BOT_E2EE_UNSUPPORTED));
        }
        Bot bot = bots.findById(access.workspaceId(), botId)
                .orElseThrow(() -> BotErrors.notFound(access.workspaceId(), botId));
        if (!bot.isActive()) {
            throw DomainException.unprocessable(ErrorCode.BOT_DISABLED,
                    "A disabled bot cannot be installed",
                    Map.of("bot_id", botId.toString(), "status", bot.status().name()));
        }
        Instant now = clock.now();
        boolean inserted = chatBots.install(access.workspaceId(), chatId, botId,
                principal.userId(), now);
        if (inserted) {
            audit.append(new AuditRecord(access.workspaceId(), principal.userId(), ACTION,
                    "chat", chatId, principal.requestId(),
                    Map.of("bot_id", botId.toString()), now));
        }
        ChatBot installation = chatBots.find(access.workspaceId(), chatId, botId)
                .orElseThrow(DomainException::internal);
        return new ChatBotView(chatId, BotView.from(bot), installation.enabled(),
                installation.installedAt());
    }
}
