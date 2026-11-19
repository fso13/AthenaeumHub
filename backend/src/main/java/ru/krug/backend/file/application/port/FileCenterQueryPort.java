package ru.krug.backend.file.application.port;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import ru.krug.backend.file.application.model.FileCenterRow;

/**
 * Read-only cross-table query for the file center. The implementation joins
 * {@code file.attachments} with {@code chat.chats}/{@code chat.chat_members} and verifies a
 * live managed message, so membership and E2EE exclusion are enforced in the same SQL
 * statement as pagination (no N+1, no post-filtering that could break the page size).
 *
 * <p>Application code passes already validated/normalized values; {@code null} means "no
 * filter". The caller must have activated the tenant context before calling.
 */
public interface FileCenterQueryPort {

    List<FileCenterRow> findPage(FileCenterQuery query);

    /**
     * Validated query values. {@code fetchLimit} is the raw SQL {@code LIMIT}; the list
     * service passes {@code pageSize + 1} to derive {@code has_more} without a count query.
     */
    record FileCenterQuery(
            UUID workspaceId,
            UUID userId,
            UUID chatId,
            String kind,
            String scanStatus,
            String search,
            String mime,
            String extension,
            Instant cursorCreatedAt,
            UUID cursorId,
            int fetchLimit) {
    }
}
