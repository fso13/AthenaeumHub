package ru.krug.backend.workspace.domain.repository;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import ru.krug.backend.workspace.domain.model.DlpAction;
import ru.krug.backend.workspace.domain.model.DlpEvent;

/**
 * Read side of the append-only DLP event log. There is intentionally no update/delete
 * method: the runtime role has only SELECT/INSERT on {@code workspace.dlp_events}.
 */
public interface DlpEventRepository {

    /**
     * Newest-first keyset page. {@code policyId}, {@code action} and the cursor are
     * optional filters; {@code limit} is already validated by the application.
     */
    List<DlpEvent> findEvents(UUID workspaceId, UUID policyId, DlpAction action,
                              Instant cursorCreatedAt, UUID cursorId, int limit);
}
