package ru.krug.backend.auth.api;

import java.util.UUID;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import ru.krug.backend.auth.api.dto.BlockedUserListResponse;
import ru.krug.backend.auth.api.dto.BlockedUserResponse;
import ru.krug.backend.auth.application.usecase.UserBlockService;
import ru.krug.backend.shared.application.model.Principal;

/**
 * Self-service user blocks (#79).
 *
 * <pre>
 * POST   /users/{userId}/block — block (idempotent, 204)
 * DELETE /users/{userId}/block — unblock (idempotent, 204)
 * GET    /me/blocked           — own block list (user_id + blocked_at only)
 * </pre>
 *
 * <p>There is no user id in the self-service path and no way to read another user's list:
 * the table is protected by a self-only RLS policy.</p>
 */
@RestController
@RequestMapping("/api/v1")
public class UserBlockController {

    private final UserBlockService blocks;

    public UserBlockController(UserBlockService blocks) {
        this.blocks = blocks;
    }

    @PostMapping("/users/{userId}/block")
    public ResponseEntity<Void> block(@PathVariable UUID userId, Principal principal) {
        blocks.setBlocked(principal, userId, true);
        return ResponseEntity.noContent().build();
    }

    @DeleteMapping("/users/{userId}/block")
    public ResponseEntity<Void> unblock(@PathVariable UUID userId, Principal principal) {
        blocks.setBlocked(principal, userId, false);
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/me/blocked")
    public BlockedUserListResponse blocked(Principal principal) {
        return new BlockedUserListResponse(blocks.list(principal).stream()
                .map(view -> new BlockedUserResponse(view.userId(), view.blockedAt()))
                .toList());
    }
}
