package ru.krug.backend.ops.api;

import java.util.UUID;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.ops.application.usecase.ChangeUserStatusService;
import ru.krug.backend.shared.application.model.Principal;

/**
 * {@code POST /admin/users/{userId}/suspend|activate} (FR-ADM-15). Controllers stay thin:
 * the platform-admin guard, self/last-admin checks, Keycloak changes and audit live in
 * {@link ChangeUserStatusService}. Both actions answer {@code 204 No Content}; the response
 * deliberately carries no user data.
 */
@RestController
@RequestMapping("/api/v1/admin/users")
public class AdminUserActionsController {

    private final ChangeUserStatusService statusService;

    public AdminUserActionsController(ChangeUserStatusService statusService) {
        this.statusService = statusService;
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
}
