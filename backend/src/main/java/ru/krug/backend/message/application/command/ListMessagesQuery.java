package ru.krug.backend.message.application.command;

import java.util.UUID;

import ru.krug.backend.shared.application.model.Principal;

/**
 * Message page query. {@code threadRootId == null} means the main feed (roots only);
 * otherwise the page contains replies of exactly that flat thread.
 */
public record ListMessagesQuery(
        Principal principal,
        UUID chatId,
        Long afterSeq,
        Long beforeSeq,
        Integer limit,
        UUID threadRootId) {

    public ListMessagesQuery(Principal principal, UUID chatId, Long afterSeq, Long beforeSeq,
                             Integer limit) {
        this(principal, chatId, afterSeq, beforeSeq, limit, null);
    }
}
