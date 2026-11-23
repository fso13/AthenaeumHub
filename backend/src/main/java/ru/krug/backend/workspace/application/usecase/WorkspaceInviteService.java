package ru.krug.backend.workspace.application.usecase;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.ops.application.model.OutboundEmail;
import ru.krug.backend.ops.application.port.EmailDeliveryException;
import ru.krug.backend.ops.application.port.EmailDeliveryPort;
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
import ru.krug.backend.workspace.application.model.WorkspaceInvitePreviewView;
import ru.krug.backend.workspace.application.model.WorkspaceInviteView;
import ru.krug.backend.workspace.application.model.WorkspaceSummaryView;
import ru.krug.backend.workspace.application.port.WorkspaceInviteSettings;
import ru.krug.backend.workspace.domain.model.Membership;
import ru.krug.backend.workspace.domain.model.WorkspaceInvite;
import ru.krug.backend.workspace.domain.model.WorkspaceInviteAcceptance;
import ru.krug.backend.workspace.domain.model.WorkspaceInvitePreview;
import ru.krug.backend.workspace.domain.model.WorkspacePermission;
import ru.krug.backend.workspace.domain.repository.WorkspaceInviteRepository;
import ru.krug.backend.workspace.domain.service.WorkspaceInvitePolicy;
import ru.krug.backend.workspace.domain.service.WorkspaceInviteTokens;

/**
 * Workspace invite links (P0-4 / #82, #100): create, list, preview, revoke, accept and the
 * registration claim.
 *
 * <p>Security invariants: only the SHA-256 token hash is stored; create/list/revoke require
 * {@code manage_invites} (OWNER/ADMIN by default) and the role ceiling; accept runs through
 * a SECURITY DEFINER function that locks the invite row while {@code max_uses} and the
 * email binding are enforced; expired/revoked/exhausted links answer {@code 410}; a
 * mismatched account gets {@code 403} and does not consume the invite; audit contains
 * metadata (ids/role/bounds) only.</p>
 *
 * <p>#100 email-bound invites are single-use, store the normalized address, mail the
 * acceptance link through the existing SMTP adapter and are rate-limited per workspace and
 * per address. Link invites (no email) keep their existing email-less, multi-use
 * behaviour.</p>
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
    static final String WEB_ACCEPT_PATH = "/workspace-invite/";

    private static final DateTimeFormatter EXPIRY_FORMAT =
            DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm 'UTC'").withZone(ZoneOffset.UTC);

    private final WorkspacePermissionGuard guard;
    private final WorkspaceInviteRepository invites;
    private final WorkspaceQueryService workspaceQuery;
    private final RateLimitPort rateLimit;
    private final TenantContext tenantContext;
    private final AuditPort audit;
    private final ClockPort clock;
    private final EmailDeliveryPort email;
    private final WorkspaceInviteSettings settings;

    public WorkspaceInviteService(WorkspacePermissionGuard guard,
                                  WorkspaceInviteRepository invites,
                                  WorkspaceQueryService workspaceQuery, RateLimitPort rateLimit,
                                  TenantContext tenantContext, AuditPort audit, ClockPort clock,
                                  EmailDeliveryPort email, WorkspaceInviteSettings settings) {
        this.guard = guard;
        this.invites = invites;
        this.workspaceQuery = workspaceQuery;
        this.rateLimit = rateLimit;
        this.tenantContext = tenantContext;
        this.audit = audit;
        this.clock = clock;
        this.email = email;
        this.settings = settings;
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
        String recipient = WorkspaceInvitePolicy.normalizeEmail(command == null ? null
                : command.email());
        Integer maxUses = normalizeMaxUses(command == null ? null : command.maxUses(), recipient);
        long expiresIn = normalizeExpiresIn(command == null ? null
                : command.expiresInSeconds());

        if (recipient != null) {
            // Sending mail is an outbound side effect: bound it per workspace and per
            // normalized recipient before any row/SMTP work happens.
            rateLimit.checkInviteEmailSend(principal, workspaceId, recipient);
        }

        Instant now = clock.now();
        WorkspaceInvite invite = WorkspaceInvite.create(UUID.randomUUID(), workspaceId, role,
                maxUses, now.plusSeconds(expiresIn), now, principal.userId(), recipient);
        String token = WorkspaceInviteTokens.newToken();
        invites.save(workspaceId, invite, WorkspaceInviteTokens.hash(token));
        audit.append(new AuditRecord(workspaceId, principal.userId(), ACTION_CREATED,
                "workspace_invite", invite.id(), principal.requestId(),
                metadata(invite, now), now));

        if (recipient != null) {
            WorkspaceSummaryView workspace = workspaceQuery.findById(principal, workspaceId);
            deliverInvitation(workspace, invite, token);
        }
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

    /**
     * #100 public preview. The token is a bearer secret and the route has no session, so
     * the lookup is rate-limited per client IP and goes through the SECURITY DEFINER
     * preview function. Only workspace display metadata and the email-bound flag are
     * returned.
     */
    @Transactional(readOnly = true)
    public WorkspaceInvitePreviewView preview(String token, String clientIp) {
        rateLimit.checkInvitePreview(clientIp);
        if (!WorkspaceInviteTokens.isWellFormed(token)) {
            throw inviteNotFound();
        }
        WorkspaceInvitePreview preview = invites.preview(WorkspaceInviteTokens.hash(token));
        return switch (preview.status()) {
            case OK -> new WorkspaceInvitePreviewView(preview.workspaceName(),
                    preview.workspaceSlug(), preview.role(), preview.emailBound(),
                    preview.expiresAt());
            case REVOKED -> throw DomainException.gone(ErrorCode.WORKSPACE_INVITE_REVOKED,
                    "The invite link has been revoked", Map.of());
            case EXPIRED -> throw DomainException.gone(ErrorCode.WORKSPACE_INVITE_EXPIRED,
                    "The invite link has expired", Map.of());
            case EXHAUSTED -> throw DomainException.gone(ErrorCode.WORKSPACE_INVITE_EXHAUSTED,
                    "The invite link has reached its maximum number of uses", Map.of());
            case WORKSPACE_UNAVAILABLE, NOT_FOUND -> throw inviteNotFound();
        };
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
        // SECURITY DEFINER lookup, which enforces workspace/expiry/max_uses/email binding.
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
            case EMAIL_MISMATCH -> throw DomainException.forbidden(
                    ErrorCode.WORKSPACE_INVITE_EMAIL_MISMATCH,
                    "This invite is bound to a different email address", Map.of());
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

    /**
     * #100 post-verification claim. The auth context has already provisioned the local user
     * and calls this with the invite hash it stored at registration. The same atomic
     * {@code accept_invite} function is used, so:
     *
     * <ul>
     *   <li>a still-valid invite bound to the verified address joins the user once;</li>
     *   <li>a second call is idempotent ({@code already_member}, no extra use);</li>
     *   <li>expired/revoked/exhausted or mismatched tokens are ignored and the invite row
     *       is left untouched (no claim token is ever written to audit/logs).</li>
     * </ul>
     *
     * <p>Expected non-OK outcomes are swallowed: registration/verification must not fail
     * because an invitation expired in the meantime.</p>
     */
    @Transactional
    public void claimAfterVerification(Principal principal, String tokenHash) {
        if (tokenHash == null || !tokenHash.matches("[a-f0-9]{64}")) {
            return;
        }
        tenantContext.activate(principal.withWorkspace(null));
        WorkspaceInviteAcceptance result = invites.accept(tokenHash, principal.userId());
        if (result.outcome() != WorkspaceInviteAcceptance.Outcome.OK
                || result.alreadyMember()) {
            return;
        }
        tenantContext.activate(principal.withWorkspace(result.workspaceId()));
        audit.append(new AuditRecord(result.workspaceId(), principal.userId(),
                ACTION_ACCEPTED, "workspace", result.workspaceId(), principal.requestId(),
                Map.of("invite_id", String.valueOf(result.inviteId()),
                        "role", result.role(), "claim", "registration"), clock.now()));
    }

    private void deliverInvitation(WorkspaceSummaryView workspace, WorkspaceInvite invite,
                                   String token) {
        String acceptUrl = settings.acceptBaseUrl() + WEB_ACCEPT_PATH + token;
        String body = """
                Здравствуйте!

                Вас пригласили в воркспейс «%s» с ролью %s.
                Принять приглашение: %s

                Ссылка одноразовая и действует до %s.
                Если вы не ожидали это приглашение, проигнорируйте письмо.
                """.formatted(workspace.name(), invite.role().name(), acceptUrl,
                EXPIRY_FORMAT.format(invite.expiresAt()));
        try {
            email.sendEmail(new OutboundEmail(invite.email(),
                    "Сова — приглашение в «" + workspace.name() + "»", body));
        } catch (EmailDeliveryException ex) {
            // The validation/mail failure is a transport outcome: no token, address or body
            // is logged or placed in the error details.
            throw DomainException.serviceUnavailable(ErrorCode.SMTP_UNAVAILABLE,
                    "Invitation email could not be delivered", Map.of(), 5L);
        }
    }

    private static Integer normalizeMaxUses(Integer maxUses, String email) {
        if (email != null) {
            if (maxUses != null && maxUses != 1) {
                throw DomainException.badRequest(
                        "max_uses must be 1 for an email-bound invite",
                        Map.of("field", "max_uses", "max", 1));
            }
            return 1;
        }
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
        // #100: the invited address never enters the audit chain; only the delivery kind.
        metadata.put("email_bound", invite.isEmailBound());
        return metadata;
    }

    private static WorkspaceInviteView toView(WorkspaceInvite invite, Instant now) {
        return new WorkspaceInviteView(invite.id(), invite.role().name(),
                invite.status(now).name(), invite.usedCount(), invite.maxUses(),
                invite.expiresAt(), invite.createdAt(), invite.createdBy(), invite.email());
    }

    private DomainException inviteNotFound() {
        return DomainException.notFound(ErrorCode.WORKSPACE_INVITE_NOT_FOUND,
                "Workspace invite not found", Map.of("field", "invite_id"));
    }
}
