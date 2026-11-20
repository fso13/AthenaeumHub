package ru.krug.backend.message.application.port;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.UUID;

import ru.krug.backend.message.application.model.MentionInboxRow;

/**
 * Read/update query for {@code GET /me/mentions} and {@code POST /me/mentions/read}. The
 * implementation joins the mention inbox with the chat name and the message sender in one
 * statement; the caller has activated the tenant context and verified active membership.
 */
public interface MentionInboxPort {

    List<MentionInboxRow> findPage(UUID workspaceId, UUID userId, boolean unreadOnly,
                                   Instant cursorCreatedAt, UUID cursorId, int fetchLimit);

    long countUnread(UUID workspaceId, UUID userId);

    int markRead(UUID workspaceId, UUID userId, Collection<UUID> ids, boolean all, Instant now);
}
