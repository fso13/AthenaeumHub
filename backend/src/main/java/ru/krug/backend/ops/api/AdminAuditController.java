package ru.krug.backend.ops.api;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.ops.api.dto.AdminAuditPageResponse;
import ru.krug.backend.ops.api.mapper.AdminApiMapper;
import ru.krug.backend.ops.application.usecase.ListAdminAuditService;
import ru.krug.backend.shared.application.model.Principal;

/**
 * {@code GET /admin/audit} (FR-ADM-17). Cursor pagination plus an optional exact action
 * filter; the service enforces the platform-admin guard and audits the read itself.
 */
@RestController
@RequestMapping("/api/v1/admin")
public class AdminAuditController {

    private final ListAdminAuditService auditService;

    public AdminAuditController(ListAdminAuditService auditService) {
        this.auditService = auditService;
    }

    @GetMapping("/audit")
    public AdminAuditPageResponse list(
            @RequestParam(value = "action", required = false) String action,
            @RequestParam(value = "cursor", required = false) String cursor,
            @RequestParam(value = "limit", required = false) Integer limit,
            Principal principal) {
        return AdminApiMapper.toPage(auditService.list(principal, action, cursor, limit));
    }
}
