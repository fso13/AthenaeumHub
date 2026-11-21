package ru.krug.backend.bot.application.usecase;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.bot.application.model.BotChatAccess;
import ru.krug.backend.bot.application.model.BotView;
import ru.krug.backend.bot.application.model.ChatBotView;
import ru.krug.backend.bot.application.port.BotChatAccessPort;
import ru.krug.backend.bot.domain.model.Bot;
import ru.krug.backend.bot.domain.model.ChatBot;
import ru.krug.backend.bot.domain.repository.BotRepository;
import ru.krug.backend.bot.domain.repository.ChatBotRepository;
import ru.krug.backend.shared.application.model.Principal;

/**
 * {@code GET /chats/{chatId}/bots}: any ACTIVE chat member sees which bots are installed.
 * No token/hash is ever returned; a bot whose registry row disappeared is skipped.
 */
@Service
public class ListChatBotsService {

    private final BotChatAccessPort chatAccess;
    private final BotRepository bots;
    private final ChatBotRepository chatBots;

    public ListChatBotsService(BotChatAccessPort chatAccess, BotRepository bots,
                               ChatBotRepository chatBots) {
        this.chatAccess = chatAccess;
        this.bots = bots;
        this.chatBots = chatBots;
    }

    @Transactional(readOnly = true)
    public List<ChatBotView> list(Principal principal, UUID chatId) {
        BotChatAccess access = chatAccess.requireActiveChat(principal, chatId);
        Map<UUID, Bot> byId = new LinkedHashMap<>();
        for (Bot bot : bots.findByWorkspace(access.workspaceId())) {
            byId.put(bot.id(), bot);
        }
        return chatBots.findByChat(access.workspaceId(), chatId).stream()
                .filter(installation -> byId.containsKey(installation.botId()))
                .map(installation -> view(installation, byId.get(installation.botId())))
                .toList();
    }

    static ChatBotView view(ChatBot installation, Bot bot) {
        return new ChatBotView(installation.chatId(), BotView.from(bot),
                installation.enabled(), installation.installedAt());
    }
}
