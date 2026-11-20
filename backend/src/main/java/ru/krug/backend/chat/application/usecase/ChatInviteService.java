package ru.krug.backend.chat.application.usecase;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.chat.application.command.ChatInviteCreateCommand;
import ru.krug.backend.chat.application.model.ChatInviteCreatedView;
import ru.krug.backend.chat.application.model.ChatInviteView;
import ru.krug.backend.chat.application.model.ChatMembershipContext;
import ru.krug.backend.chat.application.model.InviteAcceptanceView;
import ru.krug.backend.chat.domain.model.ChatInvite;
import ru.krug.backend.chat.domain.model.ChatPermission;
import ru.krug.backend.chat.domain.model.ChatMember;
import ru.krug.backend.chat.domain.model.InviteAcceptance;
import ru.krug.backend.chat.domain.repository.ChatInviteRepository;
import ru.krug.backend.chat.domain.service.ChatMemberPolicy;
import ru.krug.backend.chat.domain.service.InviteTokens;
import ru.krug.backend.ops.application.port.RateLimitPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * Invite links for GROUP channels (#79): create, list, revoke and accept.
 *
 * <p>Security invariants:</p>
 * <ul>
 *   <li>only the SHA-256 hex digest of a 32-byte random token is stored; the raw token is
 *       returned exactly once by create and is never recoverable (no idempotent replay);</li>
 *   <li>create/list/revoke require an ACTIVE OWNER/ADMIN participant; DIRECT chats answer
 *       {@code 422 CHAT_MEMBERSHIP_UNSUPPORTED};</li>
 *   <li>accept runs through the {@code chat.accept_invite} SECURITY DEFINER function: the
 *       caller must be an ACTIVE workspace member, the invite row is locked while
 *       {@code max_uses} is enforced, and an existing ACTIVE member gets an idempotent
 *       {@code already_member=true} answer without consuming a use;</li>
 *   <li>expired/revoked/exhausted links answer {@code 410} with distinct codes;</li>
 *   <li>accept is rate-limited per user, create per chat;</li>
 *   <li>audit contains invite id, user id, role and bounds only — never the token/hash.</li>
 * </ul>
 */
@Service
public class ChatInviteService {

    static final String ACTION_CREATED = "chat.invite.created";
    static final String ACTION_REVOKED = "chat.invite.revoked";
    static final String ACTION_ACCEPTED = "chat.invite.accepted";

    static final long DEFAULT_EXPIRES_IN_SECONDS = 7L * 24 * 60 * 60;
    static final long MIN_EXPIRES_IN_SECONDS = 300L;
    static final long MAX_EXPIRES_IN_SECONDS = 30L * 24 * 60 * 60;
    static final int MIN_MAX_USES = 1;
    static final int MAX_MAX_USES = 1000;

    private final ChatMemberAccessService access;
    private final ChatPermissionService permissions;
    private final ChatInviteRepository invites;
    private final RateLimitPort rateLimit;
    private final AuditPort audit;
    private final ClockPort clock;
    private final TenantContext tenantContext;

    public ChatInviteService(ChatMemberAccessService access, ChatPermissionService permissions,
                             ChatInviteRepository invites,
                             RateLimitPort rateLimit, AuditPort audit, ClockPort clock,
                             TenantContext tenantContext) {
        this.access = access;
        this.permissions = permissions;
        this.invites = invites;
        this.rateLimit = rateLimit;
        this.audit = audit;
        this.clock = clock;
        this.tenantContext = tenantContext;
    }

    @Transactional
    public ChatInviteCreatedView create(Principal principal, UUID chatId,
                                        ChatInviteCreateCommand command) {
        ChatMembershipContext context = access.resolve(principal, chatId);
        context.chat().requireChannelMembership();
        ChatMember actor = requireInviteActor(context);
        rateLimit.checkInviteCreate(principal, chatId);

        ChatMember.Role role = ChatMemberPolicy.requireInviteRole(command.role());
        ChatMemberPolicy.requireCanAssignInviteRole(actor.role().name(), role);
        Integer maxUses = normalizeMaxUses(command.maxUses());
        long expiresIn = normalizeExpiresIn(command.expiresInSeconds());

        Instant now = clock.now();
        ChatInvite invite = ChatInvite.create(UUID.randomUUID(), chatId, role, maxUses,
                now.plusSeconds(expiresIn), now, principal.userId());
        String token = InviteTokens.newToken();
        invites.save(context.workspaceId(), invite, InviteTokens.hash(token));

        Map<String, Object> metadata = new LinkedHashMap<>();
        metadata.put("invite_id", invite.id().toString());
        metadata.put("role", role.name());
        metadata.put("max_uses", maxUses == null ? "UNLIMITED" : maxUses);
        metadata.put("expires_at", invite.expiresAt().toString());
        audit.append(new AuditRecord(context.workspaceId(), principal.userId(), ACTION_CREATED,
                "chat", chatId, principal.requestId(), metadata, now));

        return new ChatInviteCreatedView(toView(invite, now), token);
    }

    @Transactional
    public List<ChatInviteView> list(Principal principal, UUID chatId) {
        ChatMembershipContext context = access.resolve(principal, chatId);
        context.chat().requireChannelMembership();
        access.requireManager(context);
        Instant now = clock.now();
        return invites.listByChat(context.workspaceId(), chatId).stream()
                .map(invite -> toView(invite, now))
                .toList();
    }

    @Transactional
    public void revoke(Principal principal, UUID chatId, UUID inviteId) {
        ChatMembershipContext context = access.resolve(principal, chatId);
        context.chat().requireChannelMembership();
        access.requireManager(context);

        boolean revoked = invites.revoke(context.workspaceId(), chatId, inviteId,
                clock.now());
        if (!revoked) {
            // Idempotent revoke: an already-revoked link is a 204 no-op; an unknown link is
            // a 404 without disclosing other chats' invites (tenant RLS already scopes).
            ChatInvite existing = invites.findById(context.workspaceId(), chatId, inviteId)
                    .orElseThrow(this::inviteNotFound);
            if (existing.revokedAt() != null) {
                return;
            }
            throw inviteNotFound();
        }
        audit.append(new AuditRecord(context.workspaceId(), principal.userId(), ACTION_REVOKED,
                "chat", chatId, principal.requestId(),
                Map.of("invite_id", inviteId.toString()), clock.now()));
    }

    @Transactional
    public InviteAcceptanceView accept(Principal principal, String token) {
        rateLimit.checkInviteAccept(principal);
        if (!InviteTokens.isWellFormed(token)) {
            throw inviteNotFound();
        }

        // The accept URL has no workspace: only the user GUC identifies the caller for the
        // SECURITY DEFINER lookup, which enforces workspace membership and max_uses.
        tenantContext.activate(principal.withWorkspace(null));
        InviteAcceptance result = invites.accept(InviteTokens.hash(token), principal.userId());

        switch (result.outcome()) {
            case OK -> {
                if (!result.alreadyMember()) {
                    audit.append(new AuditRecord(result.workspaceId(), principal.userId(),
                            ACTION_ACCEPTED, "chat", result.chatId(), principal.requestId(),
                            Map.of("invite_id", result.inviteId().toString(),
                                    "user_id", principal.userId().toString(),
                                    "role", result.role()), clock.now()));
                }
                return new InviteAcceptanceView(result.inviteId(), result.workspaceId(),
                        result.chatId(), result.role(), result.alreadyMember());
            }
            case FORBIDDEN -> throw DomainException.forbidden(
                    "Only an active workspace member can accept this invite");
            case CHAT_UNAVAILABLE, NOT_FOUND -> throw inviteNotFound();
            case REVOKED -> throw DomainException.gone(ErrorCode.INVITE_REVOKED,
                    "The invite link has been revoked", Map.of());
            case EXPIRED -> throw DomainException.gone(ErrorCode.INVITE_EXPIRED,
                    "The invite link has expired", Map.of());
            case EXHAUSTED -> throw DomainException.gone(ErrorCode.INVITE_EXHAUSTED,
                    "The invite link has reached its maximum number of uses", Map.of());
            case JOIN_CLOSED -> throw DomainException.forbidden(ErrorCode.CHAT_JOIN_CLOSED,
                    "The channel is closed for new participants", Map.of());
        }
        throw inviteNotFound();
    }

    /**
     * P0-2: an OWNER/ADMIN may always create a link; another ACTIVE participant only with
     * the configurable {@code invite_members} right. The role ceiling still applies, so a
     * MODERATOR can invite MEMBER/GUEST only.
     */
    private ChatMember requireInviteActor(ChatMembershipContext context) {
        ChatMember actor = context.member();
        if (actor == null || !actor.isActive()) {
            throw DomainException.forbidden(
                    "Only an active channel participant can invite");
        }
        if (ChatMemberPolicy.canManage(actor.role().name())) {
            return actor;
        }
        if (permissions.allows(context.workspaceId(), context.chat().id(), actor.role(),
                ChatPermission.INVITE_MEMBERS)) {
            return actor;
        }
        throw DomainException.forbidden(
                "Only a channel OWNER/ADMIN or a role with invite_members can invite");
    }

    private static Integer normalizeMaxUses(Integer maxUses) {
        if (maxUses == null) {
            return null;
        }
        if (maxUses < MIN_MAX_USES || maxUses > MAX_MAX_USES) {
            throw DomainException.badRequest("max_uses must be 1..1000",
                    Map.of("field", "max_uses", "min", MIN_MAX_USES, "max", MAX_MAX_USES));
        }
        return maxUses;
    }

    private static long normalizeExpiresIn(Long seconds) {
        if (seconds == null) {
            return DEFAULT_EXPIRES_IN_SECONDS;
        }
        if (seconds < MIN_EXPIRES_IN_SECONDS || seconds > MAX_EXPIRES_IN_SECONDS) {
            throw DomainException.badRequest("expires_in_seconds must be 300..2592000",
                    Map.of("field", "expires_in_seconds",
                            "min", MIN_EXPIRES_IN_SECONDS,
                            "max", MAX_EXPIRES_IN_SECONDS));
        }
        return seconds;
    }

    private static ChatInviteView toView(ChatInvite invite, Instant now) {
        return new ChatInviteView(invite.id(), invite.role().name(),
                invite.status(now).name(), invite.usedCount(), invite.maxUses(),
                invite.expiresAt(), invite.createdAt(), invite.createdBy());
    }

    private DomainException inviteNotFound() {
        return DomainException.notFound(ErrorCode.INVITE_NOT_FOUND, "Invite not found",
                Map.of("field", "invite_id"));
    }
}
