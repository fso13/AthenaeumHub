package ru.krug.backend.plugin.application.usecase;

import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import ru.krug.backend.audit.application.model.AuditRecord;
import ru.krug.backend.audit.application.port.AuditPort;
import ru.krug.backend.chat.application.model.ChatView;
import ru.krug.backend.chat.application.port.MusicRoomChannelPort;
import ru.krug.backend.plugin.application.model.MusicRoomChatView;
import ru.krug.backend.plugin.application.model.MusicRoomOpenView;
import ru.krug.backend.plugin.application.model.MusicRoomPluginStateView;
import ru.krug.backend.plugin.domain.model.MusicRoom;
import ru.krug.backend.plugin.domain.model.Plugin;
import ru.krug.backend.plugin.domain.model.PluginAvailability;
import ru.krug.backend.plugin.domain.model.PluginAvailabilityPolicy;
import ru.krug.backend.plugin.domain.model.PluginMode;
import ru.krug.backend.plugin.domain.repository.ChatPluginRepository;
import ru.krug.backend.plugin.domain.repository.MusicRoomRepository;
import ru.krug.backend.plugin.domain.repository.PluginCatalogRepository;
import ru.krug.backend.shared.application.model.Principal;
import ru.krug.backend.shared.application.port.ClockPort;
import ru.krug.backend.shared.application.port.TenantContext;
import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;
import ru.krug.backend.workspace.application.port.WorkspaceAccessPort;

/**
 * {@code POST /workspaces/{workspaceId}/music-room} (#94): find-or-create the single
 * workspace music room.
 *
 * <p>Idempotency is persistent, not {@code Idempotency-Key}-based: {@code chat.plugin_rooms}
 * stores the one tagged channel per workspace. The transaction takes an advisory lock on
 * {@code (workspace, plugin)} before reading the tag, so concurrent opens cannot create two
 * channels. A stale tag whose channel was soft-deleted is repointed to a fresh channel.
 * The installation chat limits are enforced only when a channel is actually created, so a
 * repeated open of an existing room never consumes a slot.</p>
 *
 * <p>Authorization: ACTIVE workspace member only. The catalog kill switch and the chat mode
 * are checked before any write; an E2EE workspace cannot open a server-side room. The
 * channel itself is created through the chat context (creator OWNER, all ACTIVE members,
 * PUBLIC/OPEN). No audio, playback state or SFU session is created.</p>
 */
@Service
public class OpenMusicRoomService {

    static final String ACTION = "music.room.opened";

    private final TenantContext tenantContext;
    private final WorkspaceAccessPort workspaceAccess;
    private final PluginCatalogRepository catalog;
    private final ChatPluginRepository chatPlugins;
    private final MusicRoomRepository rooms;
    private final MusicRoomChannelPort channels;
    private final AuditPort audit;
    private final ClockPort clock;

    public OpenMusicRoomService(TenantContext tenantContext,
                                WorkspaceAccessPort workspaceAccess,
                                PluginCatalogRepository catalog,
                                ChatPluginRepository chatPlugins,
                                MusicRoomRepository rooms,
                                MusicRoomChannelPort channels,
                                AuditPort audit,
                                ClockPort clock) {
        this.tenantContext = tenantContext;
        this.workspaceAccess = workspaceAccess;
        this.catalog = catalog;
        this.chatPlugins = chatPlugins;
        this.rooms = rooms;
        this.channels = channels;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional
    public MusicRoomOpenView open(Principal principal, UUID workspaceId) {
        tenantContext.activate(principal.withWorkspace(workspaceId));
        workspaceAccess.requireActiveMember(workspaceId, principal.userId());

        Plugin plugin = catalog.findById(MusicRoom.PLUGIN_ID)
                .orElseThrow(() -> DomainException.notFound(ErrorCode.PLUGIN_NOT_FOUND,
                        "Plugin not found", Map.of("plugin_id", MusicRoom.PLUGIN_ID)));
        String mode = channels.workspaceSecurityMode(workspaceId);
        if (mode == null) {
            throw DomainException.notFound("Workspace not found");
        }
        PluginAvailability availability = PluginAvailabilityPolicy.evaluate(plugin,
                PluginMode.valueOf(mode));
        if (!availability.available()) {
            String reason = availability.reason().name();
            throw DomainException.unprocessable(reason,
                    "Plugin is not available in this workspace",
                    Map.of("plugin_id", MusicRoom.PLUGIN_ID, "reason", reason));
        }

        rooms.lock(workspaceId, MusicRoom.PLUGIN_ID);
        UUID taggedChatId = rooms.findChatId(workspaceId, MusicRoom.PLUGIN_ID).orElse(null);
        boolean created = false;
        ChatView chat;
        if (taggedChatId != null && channels.isLiveGroupChannel(workspaceId, taggedChatId)) {
            // Existing room: any ACTIVE member of the (PUBLIC) room gets it back; a member
            // who was removed from a now-PRIVATE room does not learn its existence.
            chat = channels.findVisibleChannel(workspaceId, taggedChatId, principal.userId())
                    .orElseThrow(() -> DomainException.notFound("Music room not found"));
            // Re-assert the toggle: a manager may have switched the plugin off, but opening
            // the room is the explicit "enable it" action of the plugin entry point.
            chatPlugins.setEnabled(workspaceId, chat.id(), MusicRoom.PLUGIN_ID, true,
                    principal.userId(), clock.now());
        } else {
            chat = channels.createPublicChannel(principal, workspaceId,
                    MusicRoom.CHANNEL_NAME);
            rooms.link(workspaceId, MusicRoom.PLUGIN_ID, chat.id(), principal.userId());
            chatPlugins.setEnabled(workspaceId, chat.id(), MusicRoom.PLUGIN_ID, true,
                    principal.userId(), clock.now());
            created = true;
        }

        audit.append(new AuditRecord(workspaceId, principal.userId(), ACTION, "chat", chat.id(),
                principal.requestId(), Map.of("created", created), clock.now()));
        return new MusicRoomOpenView(toChatView(chat), availableState(), created);
    }

    private static MusicRoomPluginStateView availableState() {
        return new MusicRoomPluginStateView(MusicRoom.PLUGIN_ID, true, true,
                MusicRoom.VERSION, null);
    }

    private static MusicRoomChatView toChatView(ChatView chat) {
        return new MusicRoomChatView(chat.id(), chat.type(), chat.securityMode(),
                chat.visibility(), chat.peerId(), chat.peerHasE2eeCapableDevices(),
                chat.name(), chat.description(), chat.keyEpoch(), chat.lastSeq(),
                chat.unreadCount(), chat.createdAt(), chat.coverFileId(), chat.avatarFileId(),
                chat.readOnly(), chat.joinPolicy(), chat.archived());
    }
}
