package ru.krug.backend.chat.domain.model;

import java.util.Objects;
import java.util.UUID;

/**
 * P0-2 channel settings kept on the chat row: cover, avatar, read-only flag and join policy.
 * DIRECT chats carry the defaults ({@code readOnly=false}, {@code joinPolicy=INVITE_ONLY},
 * no cover, no avatar) and the API rejects changing them.
 */
public record ChannelSettings(boolean readOnly, ChannelJoinPolicy joinPolicy,
                              UUID coverFileId, UUID avatarFileId) {

    public ChannelSettings {
        Objects.requireNonNull(joinPolicy, "joinPolicy");
    }

    public static ChannelSettings defaults() {
        return new ChannelSettings(false, ChannelJoinPolicy.INVITE_ONLY, null, null);
    }
}
