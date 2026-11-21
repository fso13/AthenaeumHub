package ru.krug.backend.plugin.application.port;

import java.util.List;
import java.util.UUID;

import ru.krug.backend.plugin.application.model.MusicRoomTrackView;

/**
 * Cross-context read port for the music-room AUDIO listing (#94). The implementation
 * delegates to the file-center query, so membership, E2EE exclusion, deleted-message and
 * delete-for-me rules are enforced in the same SQL statement. Only metadata is returned.
 */
public interface MusicRoomTrackPort {

    /**
     * Newest-first AUDIO attachments of the chat that the caller may see.
     *
     * @param fetchLimit raw query limit; callers pass {@code max + 1} to derive
     *                   {@code has_more} without a count query
     */
    List<MusicRoomTrackView> findAudio(UUID workspaceId, UUID userId, UUID chatId,
                                       int fetchLimit);
}
