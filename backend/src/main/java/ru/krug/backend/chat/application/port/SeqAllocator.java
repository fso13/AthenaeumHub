package ru.krug.backend.chat.application.port;

import java.util.UUID;

public interface SeqAllocator {

    /**
     * Allocates the next per-chat seq in the caller's transaction.
     */
    long nextSeq(UUID workspaceId, UUID chatId);
}
