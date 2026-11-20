package ru.krug.backend.auth.application.usecase;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.auth.application.model.BlockedUserView;
import ru.krug.backend.auth.domain.model.UserBlockMutation;
import ru.krug.backend.auth.domain.repository.UserBlockRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Self-service user blocks (#79). Blocks are identity-scoped (no workspace), idempotent and
 * never expose email/display name: the list is {@code user_id + blocked_at} only.
 *
 * <p>Audit is appended only when the block state actually changed (the SQL function reports
 * {@code UNCHANGED} for a repeated call), so retries cannot spam the audit chain. The audit
 * metadata carries the target user id only.</p>
 */
@Service
public class UserBlockService {

    static final String ACTION_BLOCKED = "user.blocked";
    static final String ACTION_UNBLOCKED = "user.unblocked";

    private final TenantContext tenantContext;
    private final UserBlockRepository blocks;
    private final AuditPort audit;
    private final ClockPort clock;

    public UserBlockService(TenantContext tenantContext, UserBlockRepository blocks,
                            AuditPort audit, ClockPort clock) {
        this.tenantContext = tenantContext;
        this.blocks = blocks;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public List<BlockedUserView> list(Principal principal) {
        tenantContext.activate(principal.withWorkspace(null));
        return blocks.findBlocked(principal.userId()).stream()
                .map(block -> new BlockedUserView(block.blockedId(), block.createdAt()))
                .toList();
    }

    @Transactional
    public void setBlocked(Principal principal, UUID targetUserId, boolean blocked) {
        tenantContext.activate(principal.withWorkspace(null));
        UserBlockMutation result = blocks.setBlocked(principal.userId(), targetUserId, blocked);
        switch (result.outcome()) {
            case OK -> audit.append(new AuditRecord(null, principal.userId(),
                    blocked ? ACTION_BLOCKED : ACTION_UNBLOCKED, "user", targetUserId,
                    principal.requestId(), Map.of("user_id", targetUserId.toString()),
                    clock.now()));
            case UNCHANGED -> {
                // Idempotent repeat: no second audit row.
            }
            case SELF -> throw DomainException.badRequest(
                    "A user cannot block themselves", Map.of("field", "user_id"));
            case USER_NOT_FOUND -> throw DomainException.notFound(ErrorCode.USER_NOT_FOUND,
                    "User not found", Map.of("field", "user_id"));
            case FORBIDDEN -> throw DomainException.forbidden("Not allowed");
        }
    }
}
