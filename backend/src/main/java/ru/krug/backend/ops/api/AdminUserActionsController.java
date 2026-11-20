package ru.krug.backend.ops.api;

import java.util.UUID;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.ops.api.dto.AdminSessionRevokeAllResponse;
import ru.krug.backend.ops.api.mapper.AdminSessionApiMapper;
import ru.krug.backend.ops.application.usecase.AdminSessionService;
import ru.krug.backend.ops.application.usecase.ChangeUserStatusService;
import ru.krug.backend.shared.application.model.Principal;

/**
 * {@code POST /admin/users/{userId}/suspend|activate|revoke-sessions} (FR-ADM-15, #84).
 * Controllers stay thin: the platform-admin guard, self/last-admin checks, Keycloak
 * changes and audit live in the use cases. Suspend/activate answer {@code 204} with no
 * body; revoke-sessions returns counts only.
 */
@RestController
@RequestMapping("/api/v1/admin/users")
public class AdminUserActionsController {

    private final ChangeUserStatusService statusService;
    private final AdminSessionService sessionService;

    public AdminUserActionsController(ChangeUserStatusService statusService,
                                      AdminSessionService sessionService) {
        this.statusService = statusService;
        this.sessionService = sessionService;
    }

    @PostMapping("/{userId}/suspend")
    public ResponseEntity<Void> suspend(@PathVariable("userId") UUID userId,
                                        Principal principal) {
        statusService.suspend(principal, userId);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/{userId}/activate")
    public ResponseEntity<Void> activate(@PathVariable("userId") UUID userId,
                                         Principal principal) {
        statusService.activate(principal, userId);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/{userId}/revoke-sessions")
    public AdminSessionRevokeAllResponse revokeSessions(@PathVariable("userId") UUID userId,
                                                        Principal principal) {
        return AdminSessionApiMapper.toResponse(sessionService.revokeAll(principal, userId));
    }
}
