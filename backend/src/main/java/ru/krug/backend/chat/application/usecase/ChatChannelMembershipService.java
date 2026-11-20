package ru.krug.backend.chat.application.usecase;

import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.port.ChatChannelMembershipPort;
import ru.krug.backend.chat.domain.repository.ChatRepository;

/** Public-channel auto-join for a newly added ACTIVE workspace member. */
@Service
public class ChatChannelMembershipService implements ChatChannelMembershipPort {

    private final ChatRepository chatRepository;

    public ChatChannelMembershipService(ChatRepository chatRepository) {
        this.chatRepository = chatRepository;
    }

    @Override
    @Transactional
    public int joinPublicChannels(UUID workspaceId, UUID userId) {
        // Serialize with ChatCreateService: a PUBLIC channel created concurrently must see
        // this membership, and this join must see that channel.
        chatRepository.lockChannelMembership(workspaceId);
        return chatRepository.addMemberToPublicChannels(workspaceId, userId);
    }
}
