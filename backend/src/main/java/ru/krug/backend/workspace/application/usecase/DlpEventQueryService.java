package ru.krug.backend.workspace.application.usecase;

import java.util.List;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.workspace.application.model.DlpEventPageView;
import ru.krug.backend.workspace.application.model.DlpEventView;
import ru.krug.backend.workspace.application.model.WorkspaceSecurityCursor;
import ru.krug.backend.workspace.application.service.DlpPolicyRequests;
import ru.krug.backend.workspace.application.service.WorkspaceSecurityRequests;
import ru.krug.backend.workspace.domain.exception.InvalidWorkspaceSecurityCursorException;
import ru.krug.backend.workspace.domain.model.DlpAction;
import ru.krug.backend.workspace.domain.model.DlpEvent;
import ru.krug.backend.workspace.domain.repository.DlpEventRepository;

/**
 * {@code GET /workspaces/{id}/dlp/events} (P0-3). OWNER/ADMIN only. The response is
 * intentionally content-free: ids, rule-name snapshot, action and timestamps only. No
 * message text, ciphertext, file name, email or IP address exists in the source table.
 */
@Service
public class DlpEventQueryService {

    private final WorkspaceSecurityGuard guard;
    private final DlpEventRepository events;

    public DlpEventQueryService(WorkspaceSecurityGuard guard, DlpEventRepository events) {
        this.guard = guard;
        this.events = events;
    }

    @Transactional(readOnly = true)
    public DlpEventPageView list(Principal principal, UUID workspaceId, UUID policyId,
                                 String actionFilter, String cursor, Integer requestedLimit) {
        guard.requireManager(principal, workspaceId);
        DlpAction action = DlpPolicyRequests.optionalAction(actionFilter);
        int limit = WorkspaceSecurityRequests.limit(requestedLimit,
                WorkspaceSecurityRequests.DEFAULT_AUDIT_LIMIT);
        WorkspaceSecurityCursor decoded = WorkspaceSecurityRequests.cursor(cursor,
                WorkspaceSecurityCursor.SCOPE_DLP, workspaceId);
        UUID cursorId = cursorId(decoded);

        List<DlpEvent> rows = events.findEvents(workspaceId, policyId, action,
                decoded == null ? null : decoded.at(), cursorId, limit + 1);
        boolean hasMore = rows.size() > limit;
        List<DlpEvent> page = hasMore ? rows.subList(0, limit) : rows;

        String nextCursor = null;
        if (hasMore && !page.isEmpty()) {
            DlpEvent last = page.get(page.size() - 1);
            nextCursor = new WorkspaceSecurityCursor(WorkspaceSecurityCursor.SCOPE_DLP,
                    workspaceId, last.createdAt(), last.id().toString()).encode();
        }
        return new DlpEventPageView(page.stream().map(DlpEventQueryService::view).toList(),
                nextCursor, hasMore);
    }

    private static UUID cursorId(WorkspaceSecurityCursor cursor) {
        if (cursor == null) {
            return null;
        }
        try {
            return UUID.fromString(cursor.key());
        } catch (IllegalArgumentException ex) {
            throw new InvalidWorkspaceSecurityCursorException();
        }
    }

    private static DlpEventView view(DlpEvent event) {
        return new DlpEventView(event.id(), event.policyId(), event.ruleName(),
                event.action().name(), event.actorId(), event.chatId(), event.createdAt());
    }
}
