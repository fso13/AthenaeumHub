package ru.krug.backend.chat.application.usecase;

import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.model.ChatMembershipContext;
import ru.krug.backend.chat.domain.model.Chat;
import ru.krug.backend.chat.domain.model.ChatMember;
import ru.krug.backend.chat.domain.model.ChatSettingsScope;
import ru.krug.backend.chat.domain.repository.ChatRepository;
import ru.krug.backend.chat.domain.service.ChatMemberPolicy;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;

/**
 * Resolves the chat-membership scope for member/invite endpoints (#79). The URL has no
 * workspace, so the workspace is looked up from the chat through the V30
 * {@code chat.settings_scope} SECURITY DEFINER function with only the user GUC active; the
 * tenant GUC is then bound for all RLS-protected reads/writes. An unknown, deleted or
 * foreign chat is hidden as {@code 404}.
 *
 * <p>This is not an authorization decision by itself: member mutations additionally require
 * an ACTIVE OWNER/ADMIN participant row (see {@code ChatMemberPolicy}).</p>
 */
@Service
public class ChatMemberAccessService {

    private final TenantContext tenantContext;
    private final ChatRepository chatRepository;

    public ChatMemberAccessService(TenantContext tenantContext, ChatRepository chatRepository) {
        this.tenantContext = tenantContext;
        this.chatRepository = chatRepository;
    }

    @Transactional
    public ChatMembershipContext resolve(Principal principal, UUID chatId) {
        tenantContext.activate(principal.withWorkspace(null));
        ChatSettingsScope scope = chatRepository.findSettingsScope(chatId, principal.userId())
                .orElseThrow(() -> DomainException.notFound("Chat not found"));
        tenantContext.activate(principal.withWorkspace(scope.workspaceId()));

        Chat chat = chatRepository.findById(scope.workspaceId(), chatId)
                .orElseThrow(() -> DomainException.notFound("Chat not found"));
        ChatMember member = chatRepository.findMember(chatId, principal.userId()).orElse(null);
        return new ChatMembershipContext(scope.workspaceId(), scope.workspaceRole(), chat,
                member);
    }

    /**
     * Returns the caller's ACTIVE participant row when the caller may manage this channel
     * (OWNER/ADMIN), otherwise throws 403. Shared by member and invite management so the
     * authorization rule exists once.
     */
    public ChatMember requireManager(ChatMembershipContext context) {
        ChatMember actor = context.member();
        if (actor == null || !actor.isActive()) {
            throw DomainException.forbidden(
                    "Only an active chat OWNER or ADMIN can manage channel members");
        }
        ChatMemberPolicy.requireManager(actor.role().name());
        return actor;
    }

    /** Any ACTIVE participant; a non-member is hidden as a 404 (existence is not disclosed). */
    public ChatMember requireParticipant(ChatMembershipContext context) {
        ChatMember actor = context.member();
        if (actor == null || !actor.isActive()) {
            throw DomainException.notFound("Chat not found");
        }
        return actor;
    }

    /** Channel settings (cover/read-only/visibility/join policy/rights): chat OWNER/ADMIN. */
    public ChatMember requireChannelManager(ChatMembershipContext context) {
        ChatMember actor = requireParticipant(context);
        if (!ChatMemberPolicy.canManage(actor.role().name())) {
            throw DomainException.forbidden(
                    "Only an active chat OWNER or ADMIN can manage channel settings");
        }
        return actor;
    }
}
