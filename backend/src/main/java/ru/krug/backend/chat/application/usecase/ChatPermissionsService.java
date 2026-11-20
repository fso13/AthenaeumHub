package ru.krug.backend.chat.application.usecase;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.chat.application.model.ChatMembershipContext;
import ru.krug.backend.chat.application.model.ChatPermissionsView;
import ru.krug.backend.chat.domain.model.ChatMember;
import ru.krug.backend.chat.domain.model.ChatPermission;
import ru.krug.backend.chat.domain.repository.ChatRepository;
import ru.krug.backend.chat.domain.service.ChatPermissionPolicy;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * {@code GET/PATCH /chats/{chatId}/permissions} (P0-2 / #80): the channel rights matrix by
 * role.
 *
 * <p>GET is available to every ACTIVE participant of a GROUP channel (transparency: a member
 * can see what they are allowed to do). PATCH is chat OWNER/ADMIN only; OWNER rights are
 * fixed and an attempt to change them is a semantic 422. A missing stored row falls back to
 * the built-in default, so the response is always complete. Audit contains role and
 * permission names only — no values, content or user data.</p>
 */
@Service
public class ChatPermissionsService {

    static final String ACTION = "chat.permissions.updated";

    private final ChatMemberAccessService access;
    private final ChatRepository chatRepository;
    private final AuditPort audit;
    private final ClockPort clock;

    public ChatPermissionsService(ChatMemberAccessService access, ChatRepository chatRepository,
                                  AuditPort audit, ClockPort clock) {
        this.access = access;
        this.chatRepository = chatRepository;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public ChatPermissionsView get(Principal principal, UUID chatId) {
        ChatMembershipContext context = access.resolve(principal, chatId);
        context.chat().requireChannelMembership();
        access.requireParticipant(context);
        return buildView(context);
    }

    @Transactional
    public ChatPermissionsView patch(Principal principal, UUID chatId,
                                     Map<String, Map<String, Boolean>> rawPatch) {
        ChatMembershipContext context = access.resolve(principal, chatId);
        context.chat().requireChannelMembership();
        access.requireChannelManager(context);
        Map<ChatMember.Role, Map<ChatPermission, Boolean>> patch =
                ChatPermissionPolicy.parsePatch(rawPatch);
        List<String> roles = apply(context, patch);

        audit.append(new AuditRecord(context.workspaceId(), principal.userId(), ACTION, "chat",
                chatId, principal.requestId(),
                Map.of("roles", roles, "permissions", permissionNames(patch)),
                clock.now()));
        return buildView(context);
    }

    /**
     * Validates and persists the patch without an audit event; used by
     * {@code PATCH /chats/{chatId}} so one request still writes one audit event.
     *
     * @return the changed role names
     */
    public List<String> apply(ChatMembershipContext context,
                              Map<ChatMember.Role, Map<ChatPermission, Boolean>> patch) {
        if (patch == null || patch.isEmpty()) {
            throw DomainException.unprocessable(ErrorCode.VALIDATION_FAILED,
                    "At least one role with at least one permission is required",
                    Map.of("reason", "empty_patch"));
        }
        List<String> roles = new ArrayList<>();
        for (Map.Entry<ChatMember.Role, Map<ChatPermission, Boolean>> entry
                : patch.entrySet()) {
            ChatMember.Role role = entry.getKey();
            ChatPermissionPolicy.requireEditableRole(role.name());
            Map<ChatPermission, Boolean> values = entry.getValue();
            if (values == null || values.isEmpty()) {
                throw DomainException.unprocessable(ErrorCode.VALIDATION_FAILED,
                        "A role patch must contain at least one permission",
                        Map.of("field", "rights", "role", role.name()));
            }
            chatRepository.upsertPermissions(context.workspaceId(), context.chat().id(),
                    role.name(), values);
            roles.add(role.name());
        }
        return List.copyOf(roles);
    }

    /** Effective matrix: stored rows merged over the built-in defaults for every role. */
    public ChatPermissionsView buildView(ChatMembershipContext context) {
        Map<String, Map<String, Boolean>> rights = new LinkedHashMap<>();
        for (ChatMember.Role role : ChatMember.Role.values()) {
            Map<ChatPermission, Boolean> stored = chatRepository.findPermissions(
                    context.workspaceId(), context.chat().id(), role.name());
            Map<String, Boolean> values = new LinkedHashMap<>();
            for (ChatPermission permission : ChatPermission.values()) {
                values.put(permission.wire(), stored.getOrDefault(permission,
                        ChatPermissionPolicy.defaultAllowed(role, permission)));
            }
            rights.put(role.name(), values);
        }
        return new ChatPermissionsView(rights);
    }

    static List<String> permissionNames(
            Map<ChatMember.Role, Map<ChatPermission, Boolean>> patch) {
        java.util.LinkedHashSet<String> names = new java.util.LinkedHashSet<>();
        patch.values().forEach(values -> values.keySet()
                .forEach(permission -> names.add(permission.wire())));
        return List.copyOf(names);
    }
}
