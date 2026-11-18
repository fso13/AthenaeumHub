package ru.krug.backend.chat.application.usecase;

import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.chat.application.model.ChatView;
import ru.krug.backend.chat.application.model.CreateChatResult;
import ru.krug.backend.chat.application.port.ChatUsagePort;
import ru.krug.backend.chat.domain.model.Chat;
import ru.krug.backend.chat.domain.model.ChatCounter;
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
 */
@Service
public class ChatCreateService {

    private final TenantContext tenantContext;
    private final WorkspaceAccessPort workspaceAccess;
    private final ChatRepository chatRepository;
    private final IdempotencyPort idempotency;
    private final RequestCanonicalizer canonicalizer;
    private final E2eeSettingsPort e2eeSettings;
    private final ChatUsagePort chatUsage;
    private final ClockPort clock;

    public ChatCreateService(TenantContext tenantContext, WorkspaceAccessPort workspaceAccess,
                             ChatRepository chatRepository, IdempotencyPort idempotency,
                             RequestCanonicalizer canonicalizer, E2eeSettingsPort e2eeSettings,
                             ChatUsagePort chatUsage, ClockPort clock) {
        this.tenantContext = tenantContext;
        this.workspaceAccess = workspaceAccess;
        this.chatRepository = chatRepository;
        this.idempotency = idempotency;
        this.canonicalizer = canonicalizer;
        this.e2eeSettings = e2eeSettings;
        this.chatUsage = chatUsage;
        this.clock = clock;
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
        // Single domain rule: E2EE supports DIRECT only in E7 (§6.2.8).
        Chat.requireSupportedType(Chat.SecurityMode.valueOf(mode), type);

        if (type == Chat.Type.DIRECT) {
            return createDirect(principal, workspaceId, mode, command.peerId());
        }
        return createGroup(principal, workspaceId, mode, command.name(), idempotencyKey);
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
            return new CreateChatResult(200, toView(existing, summary, principal.userId()), true);
        }
        chatRepository.lockChatCreation(workspaceId);
        // Re-check under the creation lock: another transaction may have created the pair
        // while this request waited. An existing pair never consumes a new limit slot.
        existing = chatRepository.findLiveDirectByKey(workspaceId, key).orElse(null);
        if (existing != null) {
            ChatSummary summary = summary(workspaceId, principal.userId(), existing.id());
            return new CreateChatResult(200, toView(existing, summary, principal.userId()), true);
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
            return new CreateChatResult(200, toView(winner, summary, principal.userId()), true);
        }
        boolean peerCapable = chatRepository.peerHasE2eeCapableDevices(workspaceId, chat.id(),
                principal.userId());
        return new CreateChatResult(201, new ChatView(chat.id(), "DIRECT", mode, peerId,
                peerCapable, null, null, 0, 0, clock.now()), false);
    }

    private CreateChatResult createGroup(Principal principal, UUID workspaceId, String mode,
                                         String name, UUID idempotencyKey) {
        if (name == null || name.isBlank() || name.strip().length() > 120) {
            throw DomainException.badRequest("name must be 1..120 characters for GROUP",
                    Map.of("field", "name", "max_length", 120));
        }
        Principal scoped = principal.withWorkspace(workspaceId);
        String scope = "POST /api/v1/workspaces/" + workspaceId + "/chats";
        byte[] requestHash = canonicalizer.sha256("POST\n/api/v1/workspaces/" + workspaceId
                + "/chats\nGROUP\n" + name.strip());
        IdempotencyReservation reservation = idempotency.reserve(scoped, scope,
                idempotencyKey.toString(), requestHash);
        if (reservation.replay()) {
            Chat replayed = chatRepository.findById(workspaceId, reservation.resourceId())
                    .orElseThrow(() -> DomainException.conflict(ErrorCode.CONFLICT,
                            "Idempotent replay target is no longer available", Map.of()));
            ChatSummary summary = summary(workspaceId, principal.userId(), replayed.id());
            return new CreateChatResult(201, toView(replayed, summary, principal.userId()), true);
        }
        chatRepository.lockChatCreation(workspaceId);
        enforceChatLimits(workspaceId, principal.userId());
        Chat chat = Chat.createGroup(UUID.randomUUID(), workspaceId, principal.userId(),
                name, Chat.SecurityMode.valueOf(mode));
        chatRepository.saveChat(chat, ru.krug.backend.chat.domain.model.ChatMember.owner(
                chat.id(), principal.userId()), ChatCounter.newCounter(chat.id()));
        idempotency.complete(scoped, scope, idempotencyKey.toString(), requestHash, 201,
                chat.id());
        return new CreateChatResult(201, new ChatView(chat.id(), "GROUP", mode, null, false,
                chat.name(), null, 0, 0, clock.now()), false);
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

    private static ChatView toView(Chat chat, ChatSummary summary, UUID viewerId) {
        if (summary != null) {
            return new ChatView(summary.id(), summary.type().name(),
                    summary.securityMode().name(), summary.peerId(),
                    summary.peerHasE2eeCapableDevices(), summary.name(), null,
                    summary.lastSeq(), summary.unreadCount(), summary.createdAt());
        }
        return new ChatView(chat.id(), chat.type().name(), chat.securityMode().name(), null,
                false, chat.name(), null, 0, 0, null);
    }

    private static Chat.Type parseType(String value) {
        try {
            return Chat.Type.valueOf(value);
        } catch (RuntimeException ex) {
            throw DomainException.badRequest("type must be DIRECT or GROUP",
                    Map.of("field", "type"));
        }
    }

    /** Application command for POST /workspaces/{id}/chats. */
    public record ChatCreateCommand(String type, UUID peerId, String name) {
    }
}
