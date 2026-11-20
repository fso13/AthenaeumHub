package ru.krug.backend.chat.application.port;

import java.util.UUID;

/**
 * Published write port used by the workspace context when a new ACTIVE member joins.
 * PUBLIC GROUP channels are workspace-wide, so the new member must become a participant
 * immediately; PRIVATE channels are never touched.
 */
public interface ChatChannelMembershipPort {

    /**
     * Adds an ACTIVE workspace member to every live PUBLIC GROUP channel.
     *
     * @return number of participant rows inserted
     */
    int joinPublicChannels(UUID workspaceId, UUID userId);
}
