package ru.krug.backend.chat.application.port;

import java.util.UUID;

import ru.krug.backend.shared.application.model.Principal;

/**
 * Chat-side half of #105: a room is backed by one managed GROUP channel created with the
 * same invariants as {@code POST /workspaces/{workspaceId}/chats} (creator OWNER, every
 * ACTIVE workspace member, PUBLIC/OPEN, chat limits, {@code chat.created} audit). The room
 * context owns the room metadata and presence; the chat context owns the channel.
 */
public interface RoomChannelPort {

    /**
     * Creates the backing managed PUBLIC GROUP channel and returns its id.
     *
     * @throws ru.krug.backend.shared.error.DomainException 404 unknown workspace, 403 not
     *         an ACTIVE workspace member, 409 {@code CHAT_LIMIT_REACHED} at the installation
     *         limit, 409 {@code E2EE_GROUP_NOT_SUPPORTED} for an E2EE workspace
     */
    UUID createBackingChannel(Principal principal, UUID workspaceId, String name);

    /** Renames the backing channel together with the room (creator/OWNER/ADMIN checked in room). */
    void renameBackingChannel(Principal principal, UUID workspaceId, UUID chatId, String name);

    /** Soft-deletes the backing channel; the room row/messages/history are retained. */
    void closeBackingChannel(Principal principal, UUID workspaceId, UUID chatId);
}
