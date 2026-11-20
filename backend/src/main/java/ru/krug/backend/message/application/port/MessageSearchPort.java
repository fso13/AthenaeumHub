package ru.krug.backend.message.application.port;

import java.util.List;

import ru.krug.backend.message.application.model.MessageSearchCriteria;
import ru.krug.backend.message.application.model.MessageSearchRow;

/**
 * Read-only cross-table query for server-side message search (#83). Implemented in
 * infrastructure with one native SQL statement (no N+1); the caller has activated the tenant
 * context and verified workspace/chat membership before calling.
 *
 * <p>The SQL side enforces the hard privacy invariants: only {@code MANAGED} chats and
 * {@code MANAGED} messages, only live (not deleted) rows, no delete-for-me rows, and an
 * ACTIVE membership of the caller in every returned chat. E2EE ciphertext never reaches the
 * application layer.
 */
public interface MessageSearchPort {

    List<MessageSearchRow> findCandidates(MessageSearchCriteria criteria);
}
