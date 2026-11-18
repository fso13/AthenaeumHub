package ru.krug.backend.ops.application.usecase;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.auth.application.usecase.PlatformAdminGuard;
import ru.krug.backend.ops.application.model.AdminChatPageView;
import ru.krug.backend.ops.application.model.AdminChatView;
import ru.krug.backend.ops.application.model.AdminPageCursor;
import ru.krug.backend.ops.application.service.AdminDirectoryViewMapper;
import ru.krug.backend.ops.application.service.AdminPageRequests;
import ru.krug.backend.ops.domain.model.AdminChatRow;
import ru.krug.backend.ops.domain.repository.AdminDirectoryRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;

/**
 * {@code GET /admin/chats}: platform-admin cursor page of chat metadata across workspaces
 * (FR-ADM-11), filtered by workspace, chat name and type. Message bodies, E2EE envelopes
 * and attachments are never read; the audit event carries counts only.
 */
@Service
public class ListAdminChatsService {

    static final int MAX_QUERY_LENGTH = 120;
    static final String ACTION = "admin.chats.viewed";

    private final PlatformAdminGuard adminGuard;
    private final AdminDirectoryRepository directory;
    private final AuditPort audit;
    private final ClockPort clock;

    public ListAdminChatsService(PlatformAdminGuard adminGuard,
                                 AdminDirectoryRepository directory,
                                 AuditPort audit,
                                 ClockPort clock) {
        this.adminGuard = adminGuard;
        this.directory = directory;
        this.audit = audit;
        this.clock = clock;
    }

    // Not readOnly: appending the access audit event is part of the same transaction.
    @Transactional
    public AdminChatPageView list(Principal principal, UUID workspaceId, String query,
                                  String type, String cursor, Integer requestedLimit) {
        adminGuard.require(principal);
        int limit = AdminPageRequests.limit(requestedLimit);
        String search = AdminPageRequests.query(query, MAX_QUERY_LENGTH);
        String chatType = AdminPageRequests.chatType(type);
        AdminPageCursor decoded = AdminPageRequests.cursor(cursor, AdminPageCursor.SCOPE_CHATS);

        List<AdminChatRow> rows = directory.findChats(workspaceId, search, chatType,
                decoded == null ? null : decoded.createdAt(),
                decoded == null ? null : decoded.id(), limit + 1);
        boolean hasMore = rows.size() > limit;
        List<AdminChatRow> page = hasMore ? rows.subList(0, limit) : rows;

        String nextCursor = null;
        if (hasMore && !page.isEmpty()) {
            AdminChatRow last = page.get(page.size() - 1);
            nextCursor = new AdminPageCursor(AdminPageCursor.SCOPE_CHATS, last.createdAt(),
                    last.id()).encode();
        }
        List<AdminChatView> items = page.stream().map(AdminDirectoryViewMapper::toView).toList();

        audit.append(new AuditRecord(null, principal.userId(), ACTION, "admin_chats", null,
                principal.requestId(),
                Map.of("returned", items.size(), "has_more", hasMore), clock.now()));
        return new AdminChatPageView(items, nextCursor, hasMore);
    }
}
