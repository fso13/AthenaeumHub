package ru.krug.backend.workspace.application.usecase;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.ops.application.port.RateLimitPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.workspace.application.command.WorkspaceInviteCreateCommand;
import ru.krug.backend.workspace.application.model.WorkspaceAccessContext;
import ru.krug.backend.workspace.application.model.WorkspaceInviteAcceptanceView;
import ru.krug.backend.workspace.application.model.WorkspaceInviteCreatedView;
import ru.krug.backend.workspace.application.model.WorkspaceInviteView;
import ru.krug.backend.workspace.application.model.WorkspaceSummaryView;
import ru.krug.backend.workspace.domain.model.Membership;
import ru.krug.backend.workspace.domain.model.WorkspaceInvite;
import ru.krug.backend.workspace.domain.model.WorkspaceInviteAcceptance;
import ru.krug.backend.workspace.domain.model.WorkspacePermission;
import ru.krug.backend.workspace.domain.repository.WorkspaceInviteRepository;
import ru.krug.backend.workspace.domain.service.WorkspaceInvitePolicy;
import ru.krug.backend.workspace.domain.service.WorkspaceInviteTokens;

/**
 * Workspace invite links (P0-4 / #82): create, list, revoke and accept.
 *
 * <p>Security invariants: only the SHA-256 token hash is stored; create/list/revoke require
 * {@code manage_invites} (OWNER/ADMIN by default) and the role ceiling; accept runs through
 * a SECURITY DEFINER function that locks the invite row while {@code max_uses} is enforced;
 * expired/revoked/exhausted links answer {@code 410}; audit contains metadata only. No
 * email is sent: the token/accept URL goes back to the inviting OWNER/ADMIN once.</p>
 */
@Service
public class WorkspaceInviteService {

    static final String ACTION_CREATED = "workspace.invite.created";
    static final String ACTION_REVOKED = "workspace.invite.revoked";
    static final String ACTION_ACCEPTED = "workspace.invite.accepted";

    static final long DEFAULT_EXPIRES_IN_SECONDS = 7L * 24 * 60 * 60;
    static final long MIN_EXPIRES_IN_SECONDS = 300L;
    static final long MAX_EXPIRES_IN_SECONDS = 30L * 24 * 60 * 60;
    static final int MAX_MAX_USES = 1000;
    static final String ACCEPT_PATH = "/api/v1/workspace-invites/";

    private final WorkspacePermissionGuard guard;
    private final WorkspaceInviteRepository invites;
    private final WorkspaceQueryService workspaceQuery;
    private final RateLimitPort rateLimit;
    private final TenantContext tenantContext;
    private final AuditPort audit;
    private final ClockPort clock;

    public WorkspaceInviteService(WorkspacePermissionGuard guard,
                                  WorkspaceInviteRepository invites,
                                  WorkspaceQueryService workspaceQuery, RateLimitPort rateLimit,
                                  TenantContext tenantContext, AuditPort audit, ClockPort clock) {
        this.guard = guard;
        this.invites = invites;
        this.workspaceQuery = workspaceQuery;
        this.rateLimit = rateLimit;
        this.tenantContext = tenantContext;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public WorkspaceInviteCreatedView create(Principal principal, UUID workspaceId,
                                             WorkspaceInviteCreateCommand command) {
        WorkspaceAccessContext context = guard.requirePermission(principal, workspaceId,
                WorkspacePermission.MANAGE_INVITES);
        rateLimit.checkInviteCreate(principal, workspaceId);
        String roleValue = command == null || command.role() == null || command.role().isBlank()
                ? Membership.Role.MEMBER.name() : command.role();
        Membership.Role role = WorkspaceInvitePolicy.requireInvitableRole(roleValue);
        WorkspaceInvitePolicy.requireCanInvite(context.role(), role);
        Integer maxUses = normalizeMaxUses(command == null ? null : command.maxUses());
        long expiresIn = normalizeExpiresIn(command == null ? null
                : command.expiresInSeconds());

        Instant now = clock.now();
        WorkspaceInvite invite = WorkspaceInvite.create(UUID.randomUUID(), workspaceId, role,
                maxUses, now.plusSeconds(expiresIn), now, principal.userId());
        String token = WorkspaceInviteTokens.newToken();
        invites.save(workspaceId, invite, WorkspaceInviteTokens.hash(token));
        audit.append(new AuditRecord(workspaceId, principal.userId(), ACTION_CREATED,
                "workspace_invite", invite.id(), principal.requestId(),
                metadata(invite, now), now));
        return new WorkspaceInviteCreatedView(toView(invite, now), token,
                ACCEPT_PATH + token + "/accept");
    }

    @Transactional
    public List<WorkspaceInviteView> list(Principal principal, UUID workspaceId) {
        guard.requirePermission(principal, workspaceId, WorkspacePermission.MANAGE_INVITES);
        Instant now = clock.now();
        return invites.listByWorkspace(workspaceId).stream()
                .map(invite -> toView(invite, now))
                .toList();
    }

    @Transactional
    public void revoke(Principal principal, UUID workspaceId, UUID inviteId) {
        guard.requirePermission(principal, workspaceId, WorkspacePermission.MANAGE_INVITES);
        boolean revoked = invites.revoke(workspaceId, inviteId, clock.now());
        if (!revoked) {
            WorkspaceInvite existing = invites.findById(workspaceId, inviteId)
                    .orElseThrow(this::inviteNotFound);
            if (existing.revokedAt() != null) {
                return;
            }
            throw inviteNotFound();
        }
        audit.append(new AuditRecord(workspaceId, principal.userId(), ACTION_REVOKED,
                "workspace_invite", inviteId, principal.requestId(),
                Map.of("invite_id", inviteId.toString()), clock.now()));
    }

    @Transactional
    public WorkspaceInviteAcceptanceView accept(Principal principal, String token) {
        rateLimit.checkInviteAccept(principal);
        if (!WorkspaceInviteTokens.isWellFormed(token)) {
            throw inviteNotFound();
        }
        // The accept URL has no workspace: only the user GUC identifies the caller for the
        // SECURITY DEFINER lookup, which enforces workspace/expiry/max_uses.
        tenantContext.activate(principal.withWorkspace(null));
        WorkspaceInviteAcceptance result = invites.accept(WorkspaceInviteTokens.hash(token),
                principal.userId());

        switch (result.outcome()) {
            case OK -> {
                tenantContext.activate(principal.withWorkspace(result.workspaceId()));
                if (!result.alreadyMember()) {
                    audit.append(new AuditRecord(result.workspaceId(), principal.userId(),
                            ACTION_ACCEPTED, "workspace", result.workspaceId(),
                            principal.requestId(), Map.of(
                                    "invite_id", String.valueOf(result.inviteId()),
                                    "role", result.role()), clock.now()));
                }
                WorkspaceSummaryView workspace = workspaceQuery.findById(principal,
                        result.workspaceId());
                return new WorkspaceInviteAcceptanceView(workspace.id(), workspace.name(),
                        workspace.slug(), workspace.role(), result.alreadyMember());
            }
            case FORBIDDEN -> throw DomainException.forbidden(
                    "The account cannot accept this invite");
            case WORKSPACE_UNAVAILABLE, NOT_FOUND -> throw inviteNotFound();
            case REVOKED -> throw DomainException.gone(ErrorCode.WORKSPACE_INVITE_REVOKED,
                    "The invite link has been revoked", Map.of());
            case EXPIRED -> throw DomainException.gone(ErrorCode.WORKSPACE_INVITE_EXPIRED,
                    "The invite link has expired", Map.of());
            case EXHAUSTED -> throw DomainException.gone(ErrorCode.WORKSPACE_INVITE_EXHAUSTED,
                    "The invite link has reached its maximum number of uses", Map.of());
        }
        throw inviteNotFound();
    }

    private static Integer normalizeMaxUses(Integer maxUses) {
        if (maxUses == null) {
            return null;
        }
        if (maxUses < 1 || maxUses > MAX_MAX_USES) {
            throw DomainException.badRequest("max_uses must be 1..1000",
                    Map.of("field", "max_uses", "min", 1, "max", MAX_MAX_USES));
        }
        return maxUses;
    }

    private static long normalizeExpiresIn(Long seconds) {
        if (seconds == null) {
            return DEFAULT_EXPIRES_IN_SECONDS;
        }
        if (seconds < MIN_EXPIRES_IN_SECONDS || seconds > MAX_EXPIRES_IN_SECONDS) {
            throw DomainException.badRequest("expires_in_seconds must be 300..2592000",
                    Map.of("field", "expires_in_seconds", "min", MIN_EXPIRES_IN_SECONDS,
                            "max", MAX_EXPIRES_IN_SECONDS));
        }
        return seconds;
    }

    private static Map<String, Object> metadata(WorkspaceInvite invite, Instant now) {
        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("invite_id", invite.id().toString());
        metadata.put("role", invite.role().name());
        metadata.put("max_uses", invite.maxUses() == null ? "UNLIMITED" : invite.maxUses());
        metadata.put("expires_at", invite.expiresAt().toString());
        return metadata;
    }

    private static WorkspaceInviteView toView(WorkspaceInvite invite, Instant now) {
        return new WorkspaceInviteView(invite.id(), invite.role().name(),
                invite.status(now).name(), invite.usedCount(), invite.maxUses(),
                invite.expiresAt(), invite.createdAt(), invite.createdBy());
    }

    private DomainException inviteNotFound() {
        return DomainException.notFound(ErrorCode.WORKSPACE_INVITE_NOT_FOUND,
                "Workspace invite not found", Map.of("field", "invite_id"));
    }
}
