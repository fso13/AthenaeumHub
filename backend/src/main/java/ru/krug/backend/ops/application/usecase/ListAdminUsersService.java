package ru.krug.backend.ops.application.usecase;

import java.util.List;
import java.util.Map;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.auth.application.usecase.PlatformAdminGuard;
import ru.krug.backend.ops.application.model.AdminPageCursor;
import ru.krug.backend.ops.application.model.AdminUserPageView;
import ru.krug.backend.ops.application.model.AdminUserView;
import ru.krug.backend.ops.application.service.AdminDirectoryViewMapper;
import ru.krug.backend.ops.application.service.AdminPageRequests;
import ru.krug.backend.ops.domain.model.AdminUserRow;
import ru.krug.backend.ops.domain.repository.AdminDirectoryRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;

/**
 * {@code GET /admin/users}: platform-admin cursor page of user metadata and aggregate
 * counts (FR-ADM-10). The read is audited with counts only; the search string, emails and
 * display names never reach the audit metadata.
 */
@Service
public class ListAdminUsersService {

    static final int MAX_QUERY_LENGTH = 254;
    static final String ACTION = "admin.users.viewed";

    private final PlatformAdminGuard adminGuard;
    private final AdminDirectoryRepository directory;
    private final AuditPort audit;
    private final ClockPort clock;

    public ListAdminUsersService(PlatformAdminGuard adminGuard,
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
    public AdminUserPageView list(Principal principal, String query, String cursor,
                                  Integer requestedLimit) {
        adminGuard.require(principal);
        int limit = AdminPageRequests.limit(requestedLimit);
        String search = AdminPageRequests.query(query, MAX_QUERY_LENGTH);
        AdminPageCursor decoded = AdminPageRequests.cursor(cursor, AdminPageCursor.SCOPE_USERS);

        List<AdminUserRow> rows = directory.findUsers(search,
                decoded == null ? null : decoded.createdAt(),
                decoded == null ? null : decoded.id(), limit + 1);
        boolean hasMore = rows.size() > limit;
        List<AdminUserRow> page = hasMore ? rows.subList(0, limit) : rows;

        String nextCursor = null;
        if (hasMore && !page.isEmpty()) {
            AdminUserRow last = page.get(page.size() - 1);
            nextCursor = new AdminPageCursor(AdminPageCursor.SCOPE_USERS, last.createdAt(),
                    last.id()).encode();
        }
        List<AdminUserView> items = page.stream().map(AdminDirectoryViewMapper::toView).toList();

        audit.append(new AuditRecord(null, principal.userId(), ACTION, "admin_users", null,
                principal.requestId(),
                Map.of("returned", items.size(), "has_more", hasMore), clock.now()));
        return new AdminUserPageView(items, nextCursor, hasMore);
    }
}
