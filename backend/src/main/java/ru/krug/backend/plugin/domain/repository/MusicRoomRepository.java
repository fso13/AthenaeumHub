package ru.krug.backend.plugin.domain.repository;

import java.util.Optional;
import java.util.UUID;

/**
 * Persistence port for {@code chat.plugin_rooms} (#94): the per-workspace tag that makes
 * the music room find-or-create idempotent.
 *
 * <p>The table is FORCE-RLS scoped to the workspace activated by the caller. The repository
 * never reads chat content and never touches attachment bytes.</p>
 */
public interface MusicRoomRepository {

    /**
     * Serialises find-or-create for one workspace/plugin inside the caller's transaction.
     * Two concurrent open requests therefore observe the same tag row: the first creates
     * the channel and links it, the second waits and reuses it.
     */
    void lock(UUID workspaceId, String pluginId);

    /** Tagged chat id, including a soft-deleted chat; empty when the room never existed. */
    Optional<UUID> findChatId(UUID workspaceId, String pluginId);

    /**
     * Idempotent link/relink. A re-open of the same live channel changes nothing; a stale
     * tag whose channel was soft-deleted is repointed to the newly created channel.
     */
    void link(UUID workspaceId, String pluginId, UUID chatId, UUID createdBy);
}
