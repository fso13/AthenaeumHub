package ru.krug.backend.chat.application.usecase;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.chat.application.model.ChatView;
import ru.krug.backend.chat.application.model.CreateChatResult;
import ru.krug.backend.chat.application.port.ChatUsagePort;
import ru.krug.backend.chat.domain.model.ChannelVisibility;
import ru.krug.backend.chat.domain.model.Chat;
import ru.krug.backend.chat.domain.model.ChatCounter;
import ru.krug.backend.chat.domain.model.ChatMember;
import ru.krug.backend.chat.domain.model.ChatSummary;
import ru.krug.backend.chat.domain.repository.ChatRepository;
import ru.krug.backend.chat.domain.service.ChatLimitPolicy;
import ru.krug.backend.chat.domain.service.DirectPairKey;
import ru.krug.backend.ops.application.model.IdempotencyReservation;
import ru.krug.backend.ops.application.port.IdempotencyPort;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.E2eeSettingsPort;
import ru.krug.backend.shared.application.port.RequestCanonicalizer;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.workspace.application.port.WorkspaceAccessPort;

/**
 * {@code POST /workspaces/{workspaceId}/chats} (§6.2.8). DIRECT is unique by the ordered
 * participant pair: a repeated request returns the existing chat with 200. A concurrent
 * create is resolved by {@code ON CONFLICT DO NOTHING} (P2-06) — PostgreSQL aborts the
 * transaction on a unique violation, so the insert itself must be conflict-safe. GROUP
 * creation is idempotent by {@code Idempotency-Key}. {@code security_mode} is inherited
 * from the workspace, immutable, and E2EE supports DIRECT only (P2-10).
 *
 * <p>GROUP channels are PUBLIC by default: every ACTIVE workspace member joins immediately
 * and every future member joins through {@code AddWorkspaceMemberService}. PRIVATE channels
 * require an explicit list of 1..100 distinct ACTIVE workspace members (the creator is never
 * listed and becomes OWNER). The member ids are validated against the workspace, and each
 * insert is also guarded by an ACTIVE membership in SQL, so a concurrent removal cannot add
 * a foreign participant. Audit carries only the visibility literal and the member count —
 * never the selected user ids.</p>
 */
@Service
public class ChatCreateService {

    static final String ACTION = "chat.created";
    static final int MAX_PRIVATE_MEMBERS = 100;

    private final TenantContext tenantContext;
    private final WorkspaceAccessPort workspaceAccess;
    private final ChatRepository chatRepository;
    private final IdempotencyPort idempotency;
    private final RequestCanonicalizer canonicalizer;
    private final E2eeSettingsPort e2eeSettings;
    private final ChatUsagePort chatUsage;
    private final ClockPort clock;
    private final AuditPort audit;

    public ChatCreateService(TenantContext tenantContext, WorkspaceAccessPort workspaceAccess,
                             ChatRepository chatRepository, IdempotencyPort idempotency,
                             RequestCanonicalizer canonicalizer, E2eeSettingsPort e2eeSettings,
                             ChatUsagePort chatUsage, ClockPort clock, AuditPort audit) {
        this.tenantContext = tenantContext;
        this.workspaceAccess = workspaceAccess;
        this.chatRepository = chatRepository;
        this.idempotency = idempotency;
        this.canonicalizer = canonicalizer;
        this.e2eeSettings = e2eeSettings;
        this.chatUsage = chatUsage;
        this.clock = clock;
        this.audit = audit;
    }

    @Transactional
    public CreateChatResult create(Principal principal, UUID workspaceId,
                                   ChatCreateCommand command, UUID idempotencyKey) {
        tenantContext.activate(principal.withWorkspace(workspaceId));
        workspaceAccess.requireActiveMember(workspaceId, principal.userId());

        String mode = chatRepository.findWorkspaceSecurityMode(workspaceId);
        if (mode == null) {
            throw DomainException.notFound("Workspace not found");
        }
        if ("E2EE".equals(mode) && !e2eeSettings.enabled()) {
            throw DomainException.conflict(ErrorCode.E2EE_DISABLED,
                    "E2EE is disabled by the feature flag", Map.of("flag", "e2ee.enabled"));
        }
        Chat.Type type = parseType(command.type());
        if (type == Chat.Type.GROUP && command.peerId() != null) {
            throw DomainException.badRequest("peer_id is only valid for DIRECT",
                    Map.of("field", "peer_id"));
        }
        if (type == Chat.Type.DIRECT && command.peerId() == null) {
            throw DomainException.badRequest("peer_id is required for DIRECT",
                    Map.of("field", "peer_id"));
        }
        List<UUID> memberIds = normalizeMemberIds(command.memberIds());
        // Single domain rule: E2EE supports DIRECT only in E7 (§6.2.8). Visibility never
        // relaxes it.
        Chat.requireSupportedType(Chat.SecurityMode.valueOf(mode), type);

        if (type == Chat.Type.DIRECT) {
            rejectChannelFieldsForDirect(command.visibility(), memberIds);
            return createDirect(principal, workspaceId, mode, command.peerId());
        }
        ChannelVisibility visibility = parseVisibility(command.visibility());
        return createGroup(principal, workspaceId, mode, command.name(), visibility, memberIds,
                idempotencyKey);
    }

    private CreateChatResult createDirect(Principal principal, UUID workspaceId, String mode,
                                          UUID peerId) {
        if (peerId.equals(principal.userId())) {
            throw DomainException.badRequest("peer_id must differ from the caller",
                    Map.of("field", "peer_id"));
        }
        if (!workspaceAccess.isActiveMember(workspaceId, peerId)) {
            throw DomainException.badRequest("peer is not an active workspace member",
                    Map.of("field", "peer_id"));
        }
        String key = DirectPairKey.of(principal.userId(), peerId);
        Chat existing = chatRepository.findLiveDirectByKey(workspaceId, key).orElse(null);
        if (existing != null) {
            ChatSummary summary = summary(workspaceId, principal.userId(), existing.id());
            return new CreateChatResult(200, toView(existing, summary, principal.userId(), null),
                    true);
        }
        chatRepository.lockChatCreation(workspaceId);
        // Re-check under the creation lock: another transaction may have created the pair
        // while this request waited. An existing pair never consumes a new limit slot.
        existing = chatRepository.findLiveDirectByKey(workspaceId, key).orElse(null);
        if (existing != null) {
            ChatSummary summary = summary(workspaceId, principal.userId(), existing.id());
            return new CreateChatResult(200, toView(existing, summary, principal.userId(), null),
                    true);
        }
        enforceChatLimits(workspaceId, principal.userId());
        // §6.2.8: both participants need an ACTIVE e2ee-capable device before an E2EE
        // DIRECT chat is created (fail closed, never an E2EE chat without a peer device).
        if (Chat.SecurityMode.valueOf(mode) == Chat.SecurityMode.E2EE
                && (!chatRepository.userHasE2eeCapableDevice(workspaceId, principal.userId())
                    || !chatRepository.userHasE2eeCapableDevice(workspaceId, peerId))) {
            throw DomainException.conflict(ErrorCode.E2EE_NO_ACTIVE_DEVICES,
                    "Both participants need at least one active E2EE-capable device",
                    Map.of("required", "e2ee_capable_device"));
        }
        Chat chat = Chat.createDirect(UUID.randomUUID(), workspaceId, principal.userId(),
                Chat.SecurityMode.valueOf(mode));
        boolean created = chatRepository.saveDirectChat(chat, principal.userId(), peerId,
                ChatCounter.newCounter(chat.id()));
        if (!created) {
            // A concurrent request won the (workspace_id, direct_key) race. The insert was
            // conflict-safe, so this transaction is still usable: return the winner.
            Chat winner = chatRepository.findLiveDirectByKey(workspaceId, key)
                    .orElseThrow(() -> DomainException.conflict(ErrorCode.CONFLICT,
                            "Could not resolve a concurrent DIRECT chat creation", Map.of()));
            ChatSummary summary = summary(workspaceId, principal.userId(), winner.id());
            return new CreateChatResult(200, toView(winner, summary, principal.userId(), null),
                    true);
        }
        boolean peerCapable = chatRepository.peerHasE2eeCapableDevices(workspaceId, chat.id(),
                principal.userId());
        return new CreateChatResult(201,
                ChatViewAssembler.createdDirect(chat, peerId, peerCapable, clock.now()), false);
    }

    private CreateChatResult createGroup(Principal principal, UUID workspaceId, String mode,
                                         String name, ChannelVisibility visibility,
                                         List<UUID> memberIds, UUID idempotencyKey) {
        if (name == null || name.isBlank() || name.strip().length() > 120) {
            throw DomainException.badRequest("name must be 1..120 characters for GROUP",
                    Map.of("field", "name", "max_length", 120));
        }
        validateVisibilityMembers(principal, workspaceId, visibility, memberIds);
        Principal scoped = principal.withWorkspace(workspaceId);
        String scope = "POST /api/v1/workspaces/" + workspaceId + "/chats";
        // The canonical request includes the visibility and the id set, so reusing one key
        // for a different audience is rejected instead of replaying the wrong channel.
        String memberFingerprint = memberIds.stream().map(UUID::toString).sorted()
                .collect(Collectors.joining(","));
        byte[] requestHash = canonicalizer.sha256("POST\n/api/v1/workspaces/" + workspaceId
                + "/chats\nGROUP\n" + name.strip() + "\n" + visibility.name() + "\n"
                + memberFingerprint);
        IdempotencyReservation reservation = idempotency.reserve(scoped, scope,
                idempotencyKey.toString(), requestHash);
        if (reservation.replay()) {
            Chat replayed = chatRepository.findById(workspaceId, reservation.resourceId())
                    .orElseThrow(() -> DomainException.conflict(ErrorCode.CONFLICT,
                            "Idempotent replay target is no longer available", Map.of()));
            ChannelVisibility replayVisibility = chatRepository
                    .findChannelVisibility(workspaceId, replayed.id())
                    .orElse(visibility);
            ChatSummary summary = summary(workspaceId, principal.userId(), replayed.id());
            return new CreateChatResult(201,
                    toView(replayed, summary, principal.userId(), replayVisibility), true);
        }
        chatRepository.lockChatCreation(workspaceId);
        enforceChatLimits(workspaceId, principal.userId());
        Chat chat = Chat.createGroup(UUID.randomUUID(), workspaceId, principal.userId(),
                name, Chat.SecurityMode.valueOf(mode));
        chatRepository.saveChat(chat, ChatMember.owner(chat.id(), principal.userId()),
                ChatCounter.newCounter(chat.id()));
        chatRepository.saveChannelSettings(workspaceId, chat.id(), visibility);

        int memberCount;
        if (visibility == ChannelVisibility.PUBLIC) {
            // A workspace channel is visible to every ACTIVE member from its first message;
            // future joins are handled by the published channel-membership port. The owner
            // row already exists, so the returned insert count excludes the creator.
            memberCount = chatRepository.addActiveWorkspaceMembers(workspaceId, chat.id()) + 1;
        } else {
            int inserted = chatRepository.addChatMembers(workspaceId, chat.id(), memberIds);
            if (inserted != memberIds.size()) {
                // A selected member stopped being ACTIVE between validation and insert.
                throw DomainException.badRequest(
                        "member_ids must reference ACTIVE workspace members",
                        Map.of("field", "member_ids", "invalid_count",
                                memberIds.size() - inserted));
            }
            memberCount = inserted + 1;
        }

        audit.append(new AuditRecord(workspaceId, principal.userId(), ACTION, "chat",
                chat.id(), principal.requestId(),
                Map.of("visibility", visibility.name(), "member_count", memberCount),
                clock.now()));
        idempotency.complete(scoped, scope, idempotencyKey.toString(), requestHash, 201,
                chat.id());
        return new CreateChatResult(201, ChatViewAssembler.createdGroup(chat, visibility,
                ru.krug.backend.chat.domain.model.ChannelJoinPolicy.forVisibility(visibility),
                clock.now()),
                false);
    }

    private void validateVisibilityMembers(Principal principal, UUID workspaceId,
                                           ChannelVisibility visibility, List<UUID> memberIds) {
        if (visibility == ChannelVisibility.PUBLIC) {
            if (!memberIds.isEmpty()) {
                throw DomainException.badRequest(
                        "member_ids is only valid for PRIVATE GROUP channels",
                        Map.of("field", "member_ids"));
            }
            return;
        }
        if (memberIds.isEmpty()) {
            throw DomainException.badRequest(
                    "member_ids is required for a PRIVATE GROUP channel",
                    Map.of("field", "member_ids", "min_items", 1));
        }
        if (memberIds.size() > MAX_PRIVATE_MEMBERS) {
            throw DomainException.badRequest(
                    "member_ids must contain at most " + MAX_PRIVATE_MEMBERS + " users",
                    Map.of("field", "member_ids", "max_items", MAX_PRIVATE_MEMBERS));
        }
        if (memberIds.contains(principal.userId())) {
            throw DomainException.badRequest("member_ids must not contain the caller",
                    Map.of("field", "member_ids"));
        }
        int invalid = 0;
        for (UUID memberId : memberIds) {
            if (!workspaceAccess.isActiveMember(workspaceId, memberId)) {
                invalid++;
            }
        }
        if (invalid > 0) {
            throw DomainException.badRequest(
                    "member_ids must reference ACTIVE workspace members",
                    Map.of("field", "member_ids", "invalid_count", invalid));
        }
    }

    private static List<UUID> normalizeMemberIds(List<UUID> memberIds) {
        if (memberIds == null) {
            return List.of();
        }
        if (memberIds.size() > MAX_PRIVATE_MEMBERS) {
            throw DomainException.badRequest(
                    "member_ids must contain at most " + MAX_PRIVATE_MEMBERS + " users",
                    Map.of("field", "member_ids", "max_items", MAX_PRIVATE_MEMBERS));
        }
        if (memberIds.stream().anyMatch(java.util.Objects::isNull)) {
            throw DomainException.badRequest("member_ids must not contain null",
                    Map.of("field", "member_ids"));
        }
        if (new HashSet<>(memberIds).size() != memberIds.size()) {
            throw DomainException.badRequest("member_ids must not contain duplicates",
                    Map.of("field", "member_ids"));
        }
        return List.copyOf(memberIds);
    }

    private static void rejectChannelFieldsForDirect(String visibility, List<UUID> memberIds) {
        if (visibility != null) {
            throw DomainException.badRequest("visibility is only valid for GROUP",
                    Map.of("field", "visibility"));
        }
        if (!memberIds.isEmpty()) {
            throw DomainException.badRequest("member_ids is only valid for GROUP",
                    Map.of("field", "member_ids"));
        }
    }

    private void enforceChatLimits(UUID workspaceId, UUID userId) {
        var usage = chatUsage.usage(workspaceId, userId);
        ChatLimitPolicy.requireUserCapacity(usage.chatsUsedByUser(), usage.maxChatsPerUser());
        ChatLimitPolicy.requireWorkspaceCapacity(usage.chatsUsedInWorkspace(),
                usage.maxChatsPerWorkspace());
    }

    private ChatSummary summary(UUID workspaceId, UUID userId, UUID chatId) {
        return chatRepository.listActiveSummaries(workspaceId, userId).stream()
                .filter(item -> item.id().equals(chatId))
                .findFirst()
                .orElse(null);
    }

    private static ChatView toView(Chat chat, ChatSummary summary, UUID viewerId,
                                   ChannelVisibility fallbackVisibility) {
        if (summary != null) {
            ChannelVisibility visibility = summary.visibility() != null
                    ? summary.visibility() : fallbackVisibility;
            return new ChatView(summary.id(), summary.type().name(),
                    summary.securityMode().name(),
                    visibility == null ? null : visibility.name(), summary.peerId(),
                    summary.peerHasE2eeCapableDevices(), summary.name(),
                    summary.description(), null, summary.lastSeq(), summary.unreadCount(),
                    summary.createdAt(), summary.coverFileId(), summary.readOnly(),
                    summary.joinPolicy() == null ? null : summary.joinPolicy().name(),
                    summary.archived());
        }
        return new ChatView(chat.id(), chat.type().name(), chat.securityMode().name(),
                fallbackVisibility == null ? null : fallbackVisibility.name(), null, false,
                chat.name(), chat.description(), null, 0, 0, null, null, false,
                fallbackVisibility == null ? null
                        : ru.krug.backend.chat.domain.model.ChannelJoinPolicy
                                .forVisibility(fallbackVisibility).name(),
                false);
    }

    private static Chat.Type parseType(String value) {
        try {
            return Chat.Type.valueOf(value);
        } catch (RuntimeException ex) {
            throw DomainException.badRequest("type must be DIRECT or GROUP",
                    Map.of("field", "type"));
        }
    }

    private static ChannelVisibility parseVisibility(String value) {
        if (value == null || value.isBlank()) {
            return ChannelVisibility.PUBLIC;
        }
        try {
            return ChannelVisibility.valueOf(value);
        } catch (RuntimeException ex) {
            throw DomainException.badRequest("visibility must be PUBLIC or PRIVATE",
                    Map.of("field", "visibility", "allowed", "PUBLIC,PRIVATE"));
        }
    }

    /** Application command for POST /workspaces/{id}/chats. */
    public record ChatCreateCommand(String type, UUID peerId, String name, String visibility,
                                    List<UUID> memberIds) {
    }
}
