package ru.krug.backend.message.application.usecase;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.message.application.model.MentionInboxRow;
import ru.krug.backend.message.application.model.MentionPageCursor;
import ru.krug.backend.message.application.model.MentionPageView;
import ru.krug.backend.message.application.port.MentionInboxPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.workspace.application.model.WorkspaceMembershipView;
import ru.krug.backend.workspace.application.port.WorkspaceAccessPort;
import ru.krug.backend.workspace.application.port.WorkspaceDirectoryPort;

/**
 * {@code GET /me/mentions} and {@code POST /me/mentions/read} (#83).
 *
 * <p>Mentions are tenant-scoped: the caller's current workspace claim is used, otherwise
 * their first ACTIVE workspace (mirroring {@code GET /me} and the file center). The caller
 * must be an ACTIVE member. The SQL side always filters {@code user_id = caller} and RLS
 * scopes the table to that workspace, so ids cannot be used to read another user's inbox.
 *
 * <p>This inbox is independent of notification preferences: a MUTE preference suppresses the
 * notification row, not the mention record. Only metadata is returned — no message body.
 */
@Service
public class MentionInboxService {

    static final int DEFAULT_LIMIT = 30;
    static final int MAX_LIMIT = 100;
    static final int MAX_IDS = 200;

    private final TenantContext tenantContext;
    private final WorkspaceAccessPort workspaceAccess;
    private final WorkspaceDirectoryPort workspaceDirectory;
    private final MentionInboxPort inbox;
    private final ClockPort clock;

    public MentionInboxService(TenantContext tenantContext, WorkspaceAccessPort workspaceAccess,
                               WorkspaceDirectoryPort workspaceDirectory, MentionInboxPort inbox,
                               ClockPort clock) {
        this.tenantContext = tenantContext;
        this.workspaceAccess = workspaceAccess;
        this.workspaceDirectory = workspaceDirectory;
        this.inbox = inbox;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public MentionPageView list(Principal principal, UUID requestedWorkspaceId, boolean unread,
                                String cursor, Integer limit) {
        int pageSize = limit(limit);
        Principal scoped = scope(principal, requestedWorkspaceId);
        UUID workspaceId = scoped.workspaceId();
        MentionPageCursor decoded = cursor == null ? null
                : MentionPageCursor.decode(cursor, workspaceId, unread);

        List<MentionInboxRow> rows = inbox.findPage(workspaceId, scoped.userId(), unread,
                decoded == null ? null : decoded.createdAt(),
                decoded == null ? null : decoded.id(), pageSize + 1);
        boolean hasMore = rows.size() > pageSize;
        List<MentionInboxRow> items = hasMore ? rows.subList(0, pageSize) : rows;
        String nextCursor = null;
        if (hasMore && !items.isEmpty()) {
            MentionInboxRow last = items.get(items.size() - 1);
            nextCursor = new MentionPageCursor(workspaceId, unread, last.createdAt(),
                    last.id()).encode();
        }
        return new MentionPageView(items, nextCursor, hasMore,
                inbox.countUnread(workspaceId, scoped.userId()));
    }

    @Transactional
    public void markRead(Principal principal, UUID requestedWorkspaceId, List<UUID> ids,
                         boolean all) {
        if (!all && (ids == null || ids.isEmpty())) {
            throw DomainException.badRequest("ids or all=true is required",
                    Map.of("field", "ids"));
        }
        List<UUID> distinct = ids == null ? List.of()
                : ids.stream().filter(java.util.Objects::nonNull).distinct().toList();
        if (distinct.size() > MAX_IDS) {
            throw DomainException.badRequest("Too many ids",
                    Map.of("field", "ids", "limit", MAX_IDS));
        }
        Principal scoped = scope(principal, requestedWorkspaceId);
        inbox.markRead(scoped.workspaceId(), scoped.userId(), distinct, all, clock.now());
    }

    private Principal scope(Principal principal, UUID requestedWorkspaceId) {
        UUID workspaceId = requestedWorkspaceId != null ? requestedWorkspaceId
                : principal.workspaceId();
        if (workspaceId == null) {
            // Keycloak access tokens carry no workspace claim: use the first ACTIVE
            // membership, exactly like GET /me and the direct-image upload path.
            tenantContext.activate(principal.withWorkspace(null));
            List<WorkspaceMembershipView> memberships =
                    workspaceDirectory.listActiveMemberships(principal.userId());
            if (memberships.isEmpty()) {
                throw DomainException.forbidden("No active workspace");
            }
            workspaceId = memberships.get(0).id();
        }
        Principal scoped = principal.withWorkspace(workspaceId);
        tenantContext.activate(scoped);
        workspaceAccess.requireActiveMember(workspaceId, scoped.userId());
        return scoped;
    }

    private static int limit(Integer value) {
        if (value == null) {
            return DEFAULT_LIMIT;
        }
        if (value < 1 || value > MAX_LIMIT) {
            throw DomainException.badRequest("limit must be between 1 and " + MAX_LIMIT,
                    Map.of("field", "limit", "min", 1, "max", MAX_LIMIT));
        }
        return value;
    }
}
