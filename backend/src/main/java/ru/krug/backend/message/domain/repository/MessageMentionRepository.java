package ru.krug.backend.message.domain.repository;

import java.util.List;
import java.util.UUID;

import ru.krug.backend.message.domain.model.MessageMention;

/** Persistence of the per-recipient mention inbox rows. */
public interface MessageMentionRepository {

    void saveAll(List<MessageMention> mentions);

    /** Mention rows of the given messages (used by tests/maintenance, no N+1 in reads). */
    List<MessageMention> findByMessageIds(UUID workspaceId, List<UUID> messageIds);
}
