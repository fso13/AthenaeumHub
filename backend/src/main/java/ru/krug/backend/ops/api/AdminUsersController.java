package ru.krug.backend.ops.api;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.ops.api.dto.AdminUserPageResponse;
import ru.krug.backend.ops.api.mapper.AdminApiMapper;
import ru.krug.backend.ops.application.usecase.ListAdminUsersService;
import ru.krug.backend.shared.application.model.Principal;

/**
 * {@code GET /admin/users} (FR-ADM-10). The service enforces the platform-admin guard and
 * writes the access audit event; this controller only translates query parameters.
 */
@RestController
@RequestMapping("/api/v1/admin")
public class AdminUsersController {

    private final ListAdminUsersService users;

    public AdminUsersController(ListAdminUsersService users) {
        this.users = users;
    }

    @GetMapping("/users")
    public AdminUserPageResponse list(
            @RequestParam(value = "query", required = false) String query,
            @RequestParam(value = "cursor", required = false) String cursor,
            @RequestParam(value = "limit", required = false) Integer limit,
            Principal principal) {
        return AdminApiMapper.toPage(users.list(principal, query, cursor, limit));
    }
}
