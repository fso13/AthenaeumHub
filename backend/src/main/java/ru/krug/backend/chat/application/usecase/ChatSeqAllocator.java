package ru.krug.backend.chat.application.usecase;

import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.port.SeqAllocator;
import ru.krug.backend.chat.domain.model.ChatCounter;
import ru.krug.backend.chat.domain.repository.ChatRepository;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;

/**
 * Allocates seq under a row lock in the caller's transaction. A rollback leaves a gap,
 * which the contract explicitly allows; the value is never reused.
 */
@Service
public class ChatSeqAllocator implements SeqAllocator {

    private final ChatRepository chatRepository;
    private final ClockPort clock;

    public ChatSeqAllocator(ChatRepository chatRepository, ClockPort clock) {
        this.chatRepository = chatRepository;
        this.clock = clock;
    }

    @Override
    @Transactional
    public long nextSeq(UUID workspaceId, UUID chatId) {
        ChatCounter counter = chatRepository.lockCounter(chatId)
                .orElseThrow(() -> DomainException.notFound("Chat not found"));
        long seq = counter.allocate(clock.now());
        chatRepository.saveCounter(counter);
        chatRepository.touchLastMessageAt(workspaceId, chatId, clock.now());
        return seq;
    }
}
