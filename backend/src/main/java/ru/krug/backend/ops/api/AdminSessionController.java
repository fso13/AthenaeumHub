package ru.krug.backend.ops.api;

import java.util.UUID;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.ops.api.dto.AdminSessionPageResponse;
import ru.krug.backend.ops.api.mapper.AdminSessionApiMapper;
import ru.krug.backend.ops.application.usecase.AdminSessionService;
import ru.krug.backend.shared.application.model.Principal;

/**
 * Platform-admin session listing/revocation (#84). The selected local user is resolved to
 * its Keycloak subject server-side; a Keycloak outage is {@code 503 AUTH_UNAVAILABLE}.
 */
@RestController
@RequestMapping("/api/v1/admin/sessions")
public class AdminSessionController {

    private final AdminSessionService sessions;

    public AdminSessionController(AdminSessionService sessions) {
        this.sessions = sessions;
    }

    @GetMapping
    public AdminSessionPageResponse list(
            @RequestParam(value = "user_id") UUID userId,
            @RequestParam(value = "cursor", required = false) String cursor,
            @RequestParam(value = "limit", required = false) Integer limit,
            Principal principal) {
        return AdminSessionApiMapper.toPage(sessions.list(principal, userId, cursor, limit));
    }

    @DeleteMapping("/{sessionId}")
    public ResponseEntity<Void> revoke(@PathVariable String sessionId, Principal principal) {
        sessions.revoke(principal, sessionId);
        return ResponseEntity.noContent().build();
    }
}
