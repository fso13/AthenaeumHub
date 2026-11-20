package ru.krug.backend.chat.application.usecase;

import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.chat.application.model.ChatMemberAddResult;
import ru.krug.backend.chat.application.model.ChatMemberView;
import ru.krug.backend.chat.application.model.ChatMembershipContext;
import ru.krug.backend.chat.domain.model.ChatMember;
import ru.krug.backend.chat.domain.model.ChatPermission;
import ru.krug.backend.chat.domain.repository.ChatRepository;
import ru.krug.backend.chat.domain.service.ChatMemberPolicy;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.workspace.application.port.WorkspaceAccessPort;

/**
 * Channel member management (#79): add, change role, remove and leave.
 *
 * <p>Rules (all re-checked here, never trusting the client):</p>
 * <ul>
 *   <li>the caller must be an ACTIVE participant of the chat with role OWNER/ADMIN, except
 *       self-leave;</li>
 *   <li>a target must be an ACTIVE workspace member and an ACTIVE participant (add allows a
 *       REMOVED row to be re-activated);</li>
 *   <li>an ADMIN can manage only MODERATOR/MEMBER/GUEST and cannot assign OWNER/ADMIN;</li>
 *   <li>the last ACTIVE OWNER can never be demoted or removed — add/role/remove/leave all
 *       take the same per-chat advisory lock before counting owners, so two concurrent
 *       demotions cannot both succeed;</li>
 *   <li>DIRECT chats answer {@code 422 CHAT_MEMBERSHIP_UNSUPPORTED};</li>
 *   <li>chat limits are not touched: membership changes never consume a chat slot.</li>
 * </ul>
 *
 * <p>Audit carries only user ids and roles — no email, display name or content.</p>
 */
@Service
public class ChatMemberManagementService {

    static final String ACTION_ADDED = "chat.member.added";
    static final String ACTION_ROLE_CHANGED = "chat.member.role_changed";
    static final String ACTION_REMOVED = "chat.member.removed";
    static final String ACTION_LEFT = "chat.member.left";

    private final ChatMemberAccessService access;
    private final ChatPermissionService permissions;
    private final ChatRepository chatRepository;
    private final WorkspaceAccessPort workspaceAccess;
    private final AuditPort audit;
    private final ClockPort clock;

    public ChatMemberManagementService(ChatMemberAccessService access,
                                       ChatPermissionService permissions,
                                       ChatRepository chatRepository,
                                       WorkspaceAccessPort workspaceAccess,
                                       AuditPort audit, ClockPort clock) {
        this.access = access;
        this.permissions = permissions;
        this.chatRepository = chatRepository;
        this.workspaceAccess = workspaceAccess;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public ChatMemberAddResult add(Principal principal, UUID chatId, UUID targetUserId,
                                   String roleLiteral) {
        ChatMembershipContext context = access.resolve(principal, chatId);
        context.chat().requireChannelMembership();
        ChatMember actor = requireInviteActor(context);
        ChatMember.Role role = ChatMemberPolicy.requireAddRole(roleLiteral);
        ChatMemberPolicy.requireCanAssignInviteRole(actor.role().name(), role);
        if (targetUserId.equals(principal.userId())) {
            throw DomainException.conflict(ErrorCode.SELF_ACTION_FORBIDDEN,
                    "A member cannot add themselves to a channel", Map.of("field", "user_id"));
        }
        if (!workspaceAccess.isActiveMember(context.workspaceId(), targetUserId)) {
            throw DomainException.notFound(ErrorCode.USER_NOT_FOUND,
                    "User is not an active workspace member", Map.of("field", "user_id"));
        }

        chatRepository.lockChatMemberManagement(chatId);
        ChatMember existing = chatRepository.findMember(chatId, targetUserId).orElse(null);
        if (ChatMemberPolicy.isActiveMember(existing)) {
            // Idempotent: an existing ACTIVE member keeps the current role; use PATCH to
            // change it. No audit for a no-op.
            return new ChatMemberAddResult(
                    requireView(chatId, principal.userId(), targetUserId), false);
        }

        int inserted = chatRepository.insertActiveChatMember(context.workspaceId(), chatId,
                targetUserId, role.name());
        if (inserted == 0) {
            // The target stopped being an ACTIVE workspace member between the check and the
            // guarded insert; nothing was written.
            throw DomainException.notFound(ErrorCode.USER_NOT_FOUND,
                    "User is not an active workspace member", Map.of("field", "user_id"));
        }

        audit.append(new AuditRecord(context.workspaceId(), principal.userId(), ACTION_ADDED,
                "chat", chatId, principal.requestId(),
                Map.of("user_id", targetUserId.toString(), "role", role.name()), clock.now()));
        return new ChatMemberAddResult(requireView(chatId, principal.userId(), targetUserId),
                true);
    }

    /**
     * P0-2: add uses the same rule as invite creation — OWNER/ADMIN, or another ACTIVE
     * participant when the channel grants {@code invite_members}.
     */
    private ChatMember requireInviteActor(ChatMembershipContext context) {
        ChatMember actor = context.member();
        if (actor == null || !actor.isActive()) {
            throw DomainException.forbidden(
                    "Only an active channel participant can add members");
        }
        if (ChatMemberPolicy.canManage(actor.role().name())) {
            return actor;
        }
        if (permissions.allows(context.workspaceId(), context.chat().id(), actor.role(),
                ChatPermission.INVITE_MEMBERS)) {
            return actor;
        }
        throw DomainException.forbidden(
                "Only a channel OWNER/ADMIN or a role with invite_members can add members");
    }

    @Transactional
    public ChatMemberView changeRole(Principal principal, UUID chatId, UUID targetUserId,
                                     String roleLiteral) {
        ChatMembershipContext context = access.resolve(principal, chatId);
        context.chat().requireChannelMembership();
        ChatMember actor = access.requireManager(context);
        ChatMember.Role role = ChatMemberPolicy.requireRole(roleLiteral);
        ChatMemberPolicy.requireCanAssign(actor.role().name(), role);
        ChatMemberPolicy.requireNotSelf(principal.userId(), targetUserId);

        chatRepository.lockChatMemberManagement(chatId);
        ChatMember target = requireActiveMember(chatId, targetUserId);
        ChatMemberPolicy.requireCanManageTarget(actor.role().name(), target.role());

        if (target.role() == role) {
            // Idempotent repeat: no write and no audit event.
            return requireView(chatId, principal.userId(), targetUserId);
        }

        long owners = chatRepository.countActiveChatOwners(context.workspaceId(), chatId);
        ChatMemberPolicy.requireOwnerPreserved(target.role(), role, owners);

        if (!chatRepository.updateChatMemberRole(context.workspaceId(), chatId, targetUserId,
                role.name())) {
            throw memberNotFound();
        }
        audit.append(new AuditRecord(context.workspaceId(), principal.userId(),
                ACTION_ROLE_CHANGED, "chat", chatId, principal.requestId(),
                Map.of("user_id", targetUserId.toString(),
                        "previous_role", target.role().name(), "role", role.name()),
                clock.now()));
        return requireView(chatId, principal.userId(), targetUserId);
    }

    @Transactional
    public void remove(Principal principal, UUID chatId, UUID targetUserId) {
        if (targetUserId.equals(principal.userId())) {
            leave(principal, chatId);
            return;
        }
        ChatMembershipContext context = access.resolve(principal, chatId);
        context.chat().requireChannelMembership();
        ChatMember actor = access.requireManager(context);

        chatRepository.lockChatMemberManagement(chatId);
        ChatMember target = requireActiveMember(chatId, targetUserId);
        ChatMemberPolicy.requireCanManageTarget(actor.role().name(), target.role());
        long owners = chatRepository.countActiveChatOwners(context.workspaceId(), chatId);
        ChatMemberPolicy.requireOwnerPreservedOnRemoval(target.role(), owners);

        if (!chatRepository.updateChatMemberStatus(context.workspaceId(), chatId, targetUserId,
                ChatMember.Status.REMOVED.name())) {
            throw memberNotFound();
        }
        audit.append(new AuditRecord(context.workspaceId(), principal.userId(), ACTION_REMOVED,
                "chat", chatId, principal.requestId(),
                Map.of("user_id", targetUserId.toString(), "role", target.role().name()),
                clock.now()));
    }

    /** Self-removal; idempotent. The last ACTIVE OWNER cannot leave. */
    @Transactional
    public void leave(Principal principal, UUID chatId) {
        ChatMembershipContext context = access.resolve(principal, chatId);
        context.chat().requireChannelMembership();
        ChatMember member = context.member();
        if (member == null) {
            throw memberNotFound();
        }
        if (!member.isActive()) {
            // Repeated leave after an earlier removal is a no-op 204.
            return;
        }

        chatRepository.lockChatMemberManagement(chatId);
        ChatMember current = chatRepository.findMember(chatId, principal.userId()).orElse(null);
        if (current == null || !current.isActive()) {
            return;
        }
        long owners = chatRepository.countActiveChatOwners(context.workspaceId(), chatId);
        ChatMemberPolicy.requireOwnerPreservedOnRemoval(current.role(), owners);
        if (!chatRepository.updateChatMemberStatus(context.workspaceId(), chatId,
                principal.userId(), ChatMember.Status.REMOVED.name())) {
            return;
        }
        audit.append(new AuditRecord(context.workspaceId(), principal.userId(), ACTION_LEFT,
                "chat", chatId, principal.requestId(),
                Map.of("user_id", principal.userId().toString(),
                        "role", current.role().name()), clock.now()));
    }

    private ChatMember requireActiveMember(UUID chatId, UUID userId) {
        ChatMember member = chatRepository.findMember(chatId, userId).orElse(null);
        if (!ChatMemberPolicy.isActiveMember(member)) {
            throw memberNotFound();
        }
        return member;
    }

    private ChatMemberView requireView(UUID chatId, UUID viewerId, UUID targetUserId) {
        return chatRepository.findMemberDirectory(chatId, viewerId).stream()
                .filter(row -> row.userId().equals(targetUserId))
                .findFirst()
                .map(ChatMemberView::from)
                .orElseThrow(this::memberNotFound);
    }

    private DomainException memberNotFound() {
        return DomainException.notFound(ErrorCode.MEMBER_NOT_FOUND,
                "Channel member not found", Map.of("field", "user_id"));
    }
}
