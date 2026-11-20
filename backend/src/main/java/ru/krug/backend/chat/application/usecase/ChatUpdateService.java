package ru.krug.backend.chat.application.usecase;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.chat.application.command.ChatUpdateCommand;
import ru.krug.backend.chat.application.model.ChatMembershipContext;
import ru.krug.backend.chat.application.model.ChatView;
import ru.krug.backend.chat.application.port.ChatCoverPort;
import ru.krug.backend.chat.domain.model.ChannelJoinPolicy;
import ru.krug.backend.chat.domain.model.ChannelSettings;
import ru.krug.backend.chat.domain.model.ChannelVisibility;
import ru.krug.backend.chat.domain.model.Chat;
import ru.krug.backend.chat.domain.model.ChatMember;
import ru.krug.backend.chat.domain.model.ChatPermission;
import ru.krug.backend.chat.domain.repository.ChatRepository;
import ru.krug.backend.chat.domain.service.ChannelSettingsPolicy;
import ru.krug.backend.chat.domain.service.ChatPermissionPolicy;
import ru.krug.backend.chat.domain.service.ChatSettingsPolicy;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/**
 * {@code PATCH /chats/{chatId}} (D1-BE3 + P0-2 / #80): edit channel settings.
 *
 * <p>Authorization is layered and deliberately explicit:</p>
 * <ul>
 *   <li>{@code name}/{@code description} keep the D1-BE3 rule (ACTIVE workspace OWNER/ADMIN,
 *       no chat membership required). A GROUP participant with {@code change_info} may also
 *       edit them, so a channel can delegate info management without workspace rights.</li>
 *   <li>{@code cover_file_id}/{@code read_only}/{@code visibility}/{@code join_policy}/
 *       {@code rights} are structural channel settings: ACTIVE chat OWNER/ADMIN only and
 *       GROUP chats only (DIRECT answers {@code 422 CHAT_MEMBERSHIP_UNSUPPORTED}).</li>
 *   <li>E2EE keeps its restrictions: {@code description} and a managed cover are rejected
 *       with {@code 422 CHAT_SETTINGS_E2EE_UNSUPPORTED}; name, read-only, visibility, join
 *       policy and the rights matrix are policy metadata and stay allowed.</li>
 * </ul>
 *
 * <p>The audit event carries only changed field <em>names</em> — never names, descriptions,
 * file ids, message content or rights values.</p>
 */
@Service
public class ChatUpdateService {

    static final String ACTION = "chat.updated";

    private final ChatMemberAccessService access;
    private final ChatRepository chatRepository;
    private final ChatCoverPort coverPort;
    private final ChatPermissionService permissions;
    private final ChatPermissionsService permissionsService;
    private final ChatViewAssembler viewAssembler;
    private final AuditPort audit;
    private final ClockPort clock;

    public ChatUpdateService(ChatMemberAccessService access, ChatRepository chatRepository,
                             ChatCoverPort coverPort, ChatPermissionService permissions,
                             ChatPermissionsService permissionsService,
                             ChatViewAssembler viewAssembler, AuditPort audit, ClockPort clock) {
        this.access = access;
        this.chatRepository = chatRepository;
        this.coverPort = coverPort;
        this.permissions = permissions;
        this.permissionsService = permissionsService;
        this.viewAssembler = viewAssembler;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public ChatView update(Principal principal, UUID chatId, ChatUpdateCommand command) {
        if (command.isEmpty()) {
            throw DomainException.unprocessable(ErrorCode.VALIDATION_FAILED,
                    "At least one setting is required",
                    Map.of("reason", "empty_patch"));
        }
        ChatMembershipContext context = access.resolve(principal, chatId);
        Chat chat = context.chat();

        if (command.hasChannelSettings()) {
            chat.requireChannelMembership();
            access.requireChannelManager(context);
        }
        if (command.name() != null || command.description() != null) {
            requireInfoManager(context, chat);
        }
        if (chat.securityMode() == Chat.SecurityMode.E2EE && command.description() != null) {
            ChatSettingsPolicy.requireDescriptionAllowed(true);
        }
        if (chat.securityMode() == Chat.SecurityMode.E2EE && command.coverFileId() != null) {
            throw DomainException.unprocessable(ErrorCode.CHAT_SETTINGS_E2EE_UNSUPPORTED,
                    "A cover is not supported for an E2EE chat",
                    Map.of("field", "cover_file_id", "security_mode", "E2EE"));
        }

        String name = command.name() == null ? chat.name()
                : ChatSettingsPolicy.name(command.name());
        String description = command.description() == null ? chat.description()
                : ChatSettingsPolicy.description(command.description());

        ChannelSettings settings = chatRepository.findChannelSettings(context.workspaceId(),
                chatId).orElseGet(ChannelSettings::defaults);
        ChannelVisibility currentVisibility = chat.type() == Chat.Type.GROUP
                ? chatRepository.findChannelVisibility(context.workspaceId(), chatId)
                        .orElse(ChannelVisibility.PUBLIC)
                : null;
        ChannelVisibility visibility = command.visibility() == null ? currentVisibility
                : ChannelSettingsPolicy.parseVisibility(command.visibility());
        ChannelJoinPolicy joinPolicy = command.joinPolicy() == null ? settings.joinPolicy()
                : ChannelSettingsPolicy.parseJoinPolicy(command.joinPolicy());
        if (command.visibility() != null && command.joinPolicy() == null) {
            // Keep the two settings coherent without forcing the client to send both:
            // PUBLIC is inherently workspace-wide (OPEN), and leaving PUBLIC relaxes the
            // workspace-wide join unless the owner explicitly picked another policy.
            if (visibility == ChannelVisibility.PUBLIC) {
                joinPolicy = ChannelJoinPolicy.OPEN;
            } else if (settings.joinPolicy() == ChannelJoinPolicy.OPEN) {
                joinPolicy = ChannelJoinPolicy.INVITE_ONLY;
            }
        }
        ChannelSettingsPolicy.requireCoherent(visibility, joinPolicy);

        boolean readOnly = command.readOnly() == null ? settings.readOnly()
                : command.readOnly();
        UUID coverFileId = command.coverFileId() == null ? settings.coverFileId()
                : coverPort.requireCoverAttachment(context.workspaceId(), chatId,
                        command.coverFileId());

        boolean infoChanged = command.name() != null || command.description() != null;
        if (infoChanged) {
            Chat updated = chat.withSettings(name, description);
            if (!chatRepository.updateDetails(updated)) {
                throw DomainException.notFound("Chat not found");
            }
        }

        if (command.hasChannelSettings()) {
            if (!chatRepository.updateChannelSettings(context.workspaceId(), chatId,
                    coverFileId, readOnly, joinPolicy.name())) {
                throw DomainException.notFound("Chat not found");
            }
            if (command.visibility() != null && visibility != currentVisibility
                    && chatRepository.updateChannelVisibility(context.workspaceId(), chatId,
                            visibility)) {
                if (visibility == ChannelVisibility.PUBLIC) {
                    // PUBLIC is workspace-wide by definition: existing members join now,
                    // future members through the channel-membership port.
                    chatRepository.lockChannelMembership(context.workspaceId());
                    chatRepository.addActiveWorkspaceMembers(context.workspaceId(), chatId);
                }
            }
            if (command.rights() != null) {
                permissionsService.apply(context,
                        ChatPermissionPolicy.parsePatch(command.rights()));
            }
        }

        List<String> changedFields = new ArrayList<>(6);
        if (command.name() != null) {
            changedFields.add("name");
        }
        if (command.description() != null) {
            changedFields.add("description");
        }
        if (command.coverFileId() != null) {
            changedFields.add("cover_file_id");
        }
        if (command.readOnly() != null) {
            changedFields.add("read_only");
        }
        if (command.visibility() != null) {
            changedFields.add("visibility");
        }
        if (command.joinPolicy() != null) {
            changedFields.add("join_policy");
        }
        if (command.rights() != null) {
            changedFields.add("rights");
        }

        audit.append(new AuditRecord(context.workspaceId(), principal.userId(), ACTION, "chat",
                chatId, principal.requestId(), Map.of("fields", List.copyOf(changedFields)),
                clock.now()));

        return viewAssembler.toView(chat.withSettings(name, description), principal.userId());
    }

    private void requireInfoManager(ChatMembershipContext context, Chat chat) {
        if (context.workspaceManager()) {
            return;
        }
        ChatMember actor = context.member();
        if (chat.type() == Chat.Type.GROUP && actor != null && actor.isActive()) {
            if (ChatPermissionPolicy.canManage(actor.role().name())
                    || permissions.allows(context.workspaceId(), chat.id(), actor.role(),
                            ChatPermission.CHANGE_INFO)) {
                return;
            }
        }
        throw DomainException.forbidden(
                "Only a workspace OWNER/ADMIN or a channel participant with change_info "
                        + "can edit channel info");
    }
}
