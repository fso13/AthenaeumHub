package ru.krug.backend.chat.application.port;

import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.chat.application.model.ChatView;
import ru.krug.backend.shared.application.model.Principal;

/**
 * Published chat-side port for the built-in {@code music-room} plugin (#94).
 *
 * <p>The music-room context owns the plugin catalog/tag and the AUDIO listing; the chat
 * context owns channel creation and membership rules. Creating the room therefore goes
 * through this port instead of duplicating {@code ChatCreateService}'s limit/lock logic.</p>
 */
public interface MusicRoomChannelPort {

    /**
     * Creates a workspace-wide PUBLIC GROUP channel owned by the caller, adds every ACTIVE
     * workspace member, seeds the default channel permissions and writes the
     * {@code chat.created} audit event.
     *
     * @throws ru.krug.backend.shared.error.DomainException 403 when the caller is not an
     *         ACTIVE workspace member, 404 for an unknown workspace, 409
     *         {@code CHAT_LIMIT_REACHED} at the installation limit, 409
     *         {@code E2EE_GROUP_NOT_SUPPORTED} in an E2EE workspace
     */
    ChatView createPublicChannel(Principal principal, UUID workspaceId, String name);

    /** Immutable workspace security mode ({@code MANAGED}/{@code E2EE}); null if unknown. */
    String workspaceSecurityMode(UUID workspaceId);

    /** True when the id belongs to a live (not soft-deleted) GROUP channel of the workspace. */
    boolean isLiveGroupChannel(UUID workspaceId, UUID chatId);

    /**
     * Live GROUP channel view for an ACTIVE chat member. Empty for an unknown/deleted/foreign
     * chat or when the caller is not an ACTIVE member (existence is not disclosed).
     */
    Optional<ChatView> findVisibleChannel(UUID workspaceId, UUID chatId, UUID userId);
}
