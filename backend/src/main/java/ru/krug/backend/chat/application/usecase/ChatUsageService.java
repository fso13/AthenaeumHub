package ru.krug.backend.chat.application.usecase;

import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.model.ChatUsageView;
import ru.krug.backend.chat.application.port.ChatLimitSettingsPort;
import ru.krug.backend.chat.application.port.ChatUsagePort;
import ru.krug.backend.chat.domain.repository.ChatRepository;

/** Combines the installation limits with the caller/workspace chat counters. */
@Service
public class ChatUsageService implements ChatUsagePort {

    private final ChatLimitSettingsPort settings;
    private final ChatRepository chatRepository;

    public ChatUsageService(ChatLimitSettingsPort settings, ChatRepository chatRepository) {
        this.settings = settings;
        this.chatRepository = chatRepository;
    }

    @Override
    @Transactional(readOnly = true)
    public ChatUsageView usage(UUID workspaceId, UUID userId) {
        return new ChatUsageView(settings.maxChatsPerUser(), settings.maxChatsPerWorkspace(),
                chatRepository.countActiveChatsForUser(workspaceId, userId),
                chatRepository.countActiveChatsInWorkspace(workspaceId));
    }
}
